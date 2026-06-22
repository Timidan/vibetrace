// scripts/relayer.ts — hosted VibeTrace adjudication relayer.
// Holds the funded 0G key (spec §8); the CLI never sees it. Drives runAttestedAdjudicator and
// enforces auth, rate-limit, and key isolation. Run: pnpm exec tsx scripts/relayer.ts
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { runAttestedAdjudicator } from "../packages/verifier/src/index";
import { createOgAdaptersFromEnv } from "../packages/og/src/index";
// Reusable funded-write pipeline: RECOMPUTES the bundle hash, uploads to 0G Storage, anchors on 0G
// Chain, runs the read-back (incl. the signer leg when a broker is given). The relayer holds the
// funded key, so `npx vibetrace` never needs one. Import is side-effect-free (cli main is guarded).
import { anchorStoreAndVerify } from "../apps/cli/src/index";

/**
 * Hosted VibeTrace adjudication relayer — PRODUCTION-HARDENED (spec section 8).
 *
 * The funded 0G ledger key (VIBETRACE_0G_COMPUTE_PRIVATE_KEY) lives ONLY here,
 * never in the distributed `npx vibetrace` client. This module exposes the
 * security-critical pieces as pure, unit-testable functions; the broker-SDK
 * adjudication is injected via `deps.adjudicate` so it can be exercised without
 * a live wallet. Honest trust model: the enclave signature attests EXECUTION
 * over `responseHash:chatID` (it recovers to the on-chain-acknowledged TEE
 * signer), NOT the verdict content. Verdicts are trusted-transport — the client
 * re-applies the one-directional support gate locally, so a relayer-injected
 * no-support verdict word cannot survive into the published receipt.
 */

/** Extract the token from an `Authorization: Bearer <token>` header, else null. */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Constant-time authorization: the request's bearer token must exactly equal
 * the configured token. Fails closed when the configured token is empty.
 */
export function isAuthorized(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false; // no token configured → never authorize
  const presented = parseBearerToken(authHeader);
  if (presented == null) return false;
  // Compare FIXED-LENGTH SHA-256 digests with timingSafeEqual. Equal-length inputs mean the compare
  // never short-circuits, so neither the VALUE nor the LENGTH of the token leaks via timing (the old
  // `a.length !== b.length` early-return leaked length).
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Fixed-window per-key rate limiter. */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Returns true if the request is within budget; records it. */
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }
}

export type RelayerRequest = {
  headers: { authorization?: string };
  clientId: string;
  body: unknown;
};

export type RelayerResult = {
  verifierRun: { attestation: { scheme: string; processResponseValid: boolean; signingAddress: string } & Record<string, unknown> } & Record<string, unknown>;
  evidenceBadges: unknown[];
  /** TRANSIENT enclave-signed EXECUTION text (`responseHash:chatID`) — returned so the client can
   *  re-derive the TEE-EXECUTION proof (validateAttestationLocally: the signature recovers to the
   *  on-chain TEE signer), then discarded; NEVER persisted in the bundle. It attests EXECUTION, NOT
   *  the verdict content — verdicts are trusted-transport, gated client-side. */
  signedText: string;
};

export type RelayerDeps = {
  /** The shared bearer token authorized clients must present. */
  authToken: string;
  /** Whether the funded ledger key is present in the relayer's env. */
  fundedKeyPresent: boolean;
  rateLimiter: RateLimiter;
  /** Runs the broker-SDK attested adjudication. Injected for testability. */
  adjudicate: (body: unknown) => Promise<RelayerResult>;
};

export type RelayerResponse = { status: number; body: any };

/**
 * Build the relayer request handler. Guards: auth (OPTIONAL — enforced iff a token is configured)
 * → funded-key → rate-limit → adjudicate. The funded key NEVER appears in a response. Returns the
 * CANONICAL { verifierRun, evidenceBadges, signedText } shape (matches the client).
 */
export function createRelayerHandler(deps: RelayerDeps) {
  return async function handle(req: RelayerRequest): Promise<RelayerResponse> {
    // Auth is OPTIONAL: only enforced when the relayer is configured with a token (demo-friendly).
    if (deps.authToken && !isAuthorized(req.headers.authorization, deps.authToken)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (!deps.fundedKeyPresent) {
      return { status: 503, body: { error: "relayer not funded" } };
    }
    if (!deps.rateLimiter.allow(req.clientId)) {
      return { status: 429, body: { error: "rate limited" } };
    }
    try {
      // deps.adjudicate runs runAttestedAdjudicator server-side (it holds the funded key) and
      // returns the canonical { verifierRun, evidenceBadges, signedText }.
      const result = await deps.adjudicate(req.body);
      return {
        status: 200,
        body: {
          verifierRun: result.verifierRun,
          evidenceBadges: result.evidenceBadges,
          signedText: result.signedText // transient in transport; client verifies binding then persists it onto attestation.signedText
        }
      };
    } catch (err) {
      // Never surface key material or internal stack detail to the CLIENT, but log server-side for ops.
      console.error("[relayer] adjudication failed:", err instanceof Error ? (err.stack ?? err.message) : err);
      return { status: 502, body: { error: "adjudication failed" } };
    }
  };
}

export type PublishRequest = {
  headers: { authorization?: string };
  clientId: string;
  body: unknown;
};

export type PublishResponse = { status: number; body: any };

export type PublishDeps = {
  /** The shared bearer token authorized clients must present (OPTIONAL — enforced iff non-empty). */
  authToken: string;
  /** Whether the funded ledger key is present in the relayer's env. */
  fundedKeyPresent: boolean;
  rateLimiter: RateLimiter;
  /** Hard cap on graph nodes (defaults to 5000). Edges are always capped at 20000. */
  maxGraphNodes?: number;
  /**
   * Runs the FUNDED write pipeline server-side (anchorStoreAndVerify): recompute hash → upload to
   * 0G Storage → anchor on 0G Chain → read-back. Injected for testability (no network in tests).
   */
  publish: (pendingBundle: any) => Promise<any>;
};

/** Cheap structural guard for the pending bundle the client asks the relayer to anchor. */
function isWellFormedPendingBundle(value: unknown): value is {
  manifest: unknown;
  publicGraph: { nodes: unknown[]; edges?: unknown[] };
  verifierSummary: unknown;
  evidenceBadges: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.manifest !== "object" || b.manifest === null) return false;
  if (typeof b.verifierSummary !== "object" || b.verifierSummary === null) return false;
  if (b.evidenceBadges === undefined || b.evidenceBadges === null) return false;
  const graph = b.publicGraph;
  if (typeof graph !== "object" || graph === null) return false;
  if (!Array.isArray((graph as Record<string, unknown>).nodes)) return false;
  return true;
}

/**
 * Build the GUARDED /publish handler — a receipt builder, NOT an open anchor-arbitrary-JSON faucet.
 * Guard order mirrors createRelayerHandler EXACTLY: auth (OPTIONAL — enforced iff a token is
 * configured) → funded-key → rate-limit → request-shape validation (400) → graph-size cap (413) →
 * publish. Each accepted publish SPENDS GAS, so the caps and a dedicated rate limiter are the
 * abuse-control boundary. The funded key NEVER appears in a response or error.
 */
export function createPublishHandler(deps: PublishDeps) {
  return async function handle(req: PublishRequest): Promise<PublishResponse> {
    // Auth is OPTIONAL: only enforced when the relayer is configured with a token (demo-friendly).
    if (deps.authToken && !isAuthorized(req.headers.authorization, deps.authToken)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (!deps.fundedKeyPresent) {
      return { status: 503, body: { error: "relayer not funded" } };
    }
    if (!deps.rateLimiter.allow(req.clientId)) {
      return { status: 429, body: { error: "rate limited" } };
    }
    // VALIDATE the request shape BEFORE spending any gas: must be { pendingBundle } with the four
    // required bundle fields and a publicGraph.nodes array. Reject anything else as 400.
    const body = req.body as { pendingBundle?: unknown } | null | undefined;
    if (typeof body !== "object" || body === null || !isWellFormedPendingBundle(body.pendingBundle)) {
      return { status: 400, body: { error: "invalid publish request" } };
    }
    const pendingBundle = body.pendingBundle;
    const nodeCount = pendingBundle.publicGraph.nodes.length;
    const edgeCount = Array.isArray(pendingBundle.publicGraph.edges)
      ? pendingBundle.publicGraph.edges.length
      : 0;
    if (nodeCount > (deps.maxGraphNodes ?? 5000) || edgeCount > 20000) {
      return { status: 413, body: { error: "graph too large" } };
    }
    try {
      const bundle = await deps.publish(pendingBundle);
      return { status: 200, body: { bundle } };
    } catch (err) {
      // Never surface key material or internal stack detail to the CLIENT, but log server-side for ops.
      console.error("[relayer] publish failed:", err instanceof Error ? (err.stack ?? err.message) : err);
      return { status: 502, body: { error: "publish failed" } };
    }
  };
}

/**
 * Read relayer config from env. VIBETRACE_0G_COMPUTE_PRIVATE_KEY is read here
 * and ONLY here; callers receive a boolean presence flag, never the value.
 */
export function relayerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  authToken: string;
  fundedKeyPresent: boolean;
  rpcUrl: string;
} {
  return {
    authToken: env.VIBETRACE_RELAYER_AUTH_TOKEN ?? "",
    fundedKeyPresent: Boolean(env.VIBETRACE_0G_COMPUTE_PRIVATE_KEY),
    rpcUrl: env.VIBETRACE_0G_COMPUTE_RPC_URL ?? "https://evmrpc-testnet.0g.ai"
  };
}

function loadEnv(path: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
// Side-effect-free import: the pure helpers above (and the exported guard functions) stay at
// module top level; the server bootstrap below runs ONLY when this file is executed directly (tsx),
// never when scripts/relayer.test.ts imports it.
export function startRelayer() {
  // PRODUCT config source of truth is process.env (deployment env). A local scripts/.env.spike is an
  // OPTIONAL dev overlay (gitignored, holds the funded key) — process.env wins on every key, so a deployed
  // relayer needs no spike file and deleting it never breaks startup.
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = loadEnv(new URL("./.env.spike", import.meta.url).pathname);
  } catch {
    fileEnv = {}; // no dev overlay present → run purely from process.env
  }
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  const RPC_URL = env.VIBETRACE_0G_COMPUTE_RPC_URL || "https://evmrpc-testnet.0g.ai";
  const PK = env.VIBETRACE_0G_COMPUTE_PRIVATE_KEY;
  const PORT = Number(env.VIBETRACE_RELAYER_PORT || "8787");
  // Request body cap (DoS bound). A REAL self-trace bundle/graph for a sizeable repo is several MB, so
  // the old hard 2 MB cap rejected genuine large submissions outright. Make it env-tunable with a higher
  // default; floor at 2 MB so it can only ever be raised, never weakened below the original bound.
  const MAX_BODY = Math.max(2, Number(env.VIBETRACE_RELAYER_MAX_BODY_MB || "16")) * 1024 * 1024;
  if (!PK) { console.error("FATAL: VIBETRACE_0G_COMPUTE_PRIVATE_KEY missing"); process.exit(1); }

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PK, provider); // ← key isolation boundary: lives only inside the relayer
  let brokerPromise: Promise<any> | null = null;
  const getBroker = () => (brokerPromise ??= createZGComputeNetworkBroker(wallet));

  // Wire the security guards: auth → funded-key → rate-limit → adjudicate.
  const cfg = relayerConfigFromEnv(env as NodeJS.ProcessEnv);
  const rateLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
  // 0G Storage sink for the attestation quote (the funded wallet pays); env carries VIBETRACE_OG_MODE.
  const og = createOgAdaptersFromEnv({ workspace: "/tmp/vt-relayer", env: env as NodeJS.ProcessEnv });
  const quoteStorage = { uploadJson: (v: unknown) => og.storage.uploadJson(v) };

  const handle = createRelayerHandler({
    authToken: cfg.authToken,            // "" → OPEN (demo) mode; set VIBETRACE_RELAYER_AUTH_TOKEN to require a bearer
    fundedKeyPresent: cfg.fundedKeyPresent,
    rateLimiter,
    // The producer does parseAdjudicationV1 binding + dual hashes + signedText, so the
    // relayer's canonicalization matches the client validator EXACTLY.
    adjudicate: async (body: any) => runAttestedAdjudicator({
      graph: body.graph,
      broker: await getBroker(),               // BrokerLike is { inference: {...} } — pass the broker itself
      quoteStorage,
      verifiedBy: wallet.address,
      privatePacket: body.privatePacket        // undefined for public-only
    })
  });

  // FUNDED /publish path: real 0G adapters (the wallet pays for storage + chain anchoring). A SEPARATE
  // rate limiter (gas-spend budget, deliberately tighter than adjudicate) gates abuse. createOgAdapters-
  // FromEnv is forced to "real" mode so anchorStoreAndVerify writes to live 0G, not a mock sink.
  const publishAdapters = createOgAdaptersFromEnv({
    workspace: "/tmp/vt-relayer-publish",
    env: { ...env, VIBETRACE_OG_MODE: "real" } as NodeJS.ProcessEnv
  });
  const publishRateLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
  const handlePublish = createPublishHandler({
    authToken: cfg.authToken,
    fundedKeyPresent: cfg.fundedKeyPresent,
    rateLimiter: publishRateLimiter,
    // anchorStoreAndVerify RECOMPUTES the bundle hash itself, uploads + anchors with the funded wallet,
    // and runs the read-back (incl. the signer leg via the shared read-only broker). Returns the bundle.
    publish: async (pendingBundle: any) =>
      anchorStoreAndVerify(publishAdapters, pendingBundle, {
        broker: await getBroker(),
        now: () => new Date().toISOString()
      })
  });

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, relayer: wallet.address })); // address is public; key never leaves
      return;
    }
    if (req.method === "POST" && req.url === "/adjudicate") {
      // SECURITY: reject unauthenticated requests BEFORE buffering/parsing the body, so an
      // unauthenticated client cannot force body accumulation + JSON.parse at the network edge.
      // handle() re-runs the full guard chain (auth → funded-key → rate-limit) after the capped,
      // authenticated parse, so the rate-limit COUNTER stays single (only inside handle()).
      if (cfg.authToken && !isAuthorized(req.headers["authorization"], cfg.authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // MAX_BODY (env-tunable VIBETRACE_RELAYER_MAX_BODY_MB) is defined in startRelayer scope above.
      let body = "";
      let aborted = false;
      req.on("data", (c) => {
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload too large" }));
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (aborted) return;
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        const result = await handle({
          headers: { authorization: req.headers["authorization"] },
          clientId: req.socket.remoteAddress ?? "anon",
          body: parsedBody,
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/publish") {
      // Same edge-hardening as /adjudicate: reject unauthenticated requests BEFORE buffering/parsing,
      // so an unauthenticated client cannot force body accumulation + JSON.parse at the network edge.
      // handlePublish() re-runs the full guard chain after the capped, authenticated parse, so the
      // gas-spend rate-limit COUNTER increments only once (inside the handler).
      if (cfg.authToken && !isAuthorized(req.headers["authorization"], cfg.authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // MAX_BODY (env-tunable VIBETRACE_RELAYER_MAX_BODY_MB) is defined in startRelayer scope above.
      let body = "";
      let aborted = false;
      req.on("data", (c) => {
        body += c;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload too large" }));
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (aborted) return;
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        const result = await handlePublish({
          headers: { authorization: req.headers["authorization"] },
          clientId: req.socket.remoteAddress ?? "anon",
          body: parsedBody,
        });
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(PORT, () => console.log(`relayer stub on http://127.0.0.1:${PORT} (key for ${wallet.address} held server-side only)`));
  return server;
}

// Start the server ONLY when run directly (pnpm exec tsx scripts/relayer.ts), never on import (tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  startRelayer();
}
