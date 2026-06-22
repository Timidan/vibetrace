/**
 * VibeTrace registry — framework-agnostic CORE.
 *
 * This module owns ALL registry behavior: the on-disk store
 * (load/persist/seed), the bundle→summary derivation, the badge SVG
 * builders, and pure async request handlers that take plain inputs and
 * return a `{ status, headers, body }` result. It imports the workspace
 * scoring/schema packages directly, so it must be evaluated by a loader
 * that can resolve their extensionless ESM imports (tsx, or Vite's SSR
 * module graph) — never Node's native loader at vite.config load time.
 *
 * It is consumed by BOTH:
 *   - vite-registry-plugin.ts  (thin dev-server middleware adapter)
 *   - server.ts                (thin standalone Node http adapter)
 *
 * The ONLY data this registry ever holds is real, published
 * PublicLedgerBundles:
 *   - SEED: every bundle under <repo>/.vibetrace/public/*.json (VibeTrace
 *     dogfooding its own ledger), scored once on startup if the store is empty.
 *   - SUBMISSIONS: real bundles registered via handleSubmit() by POSTing
 *     directly ({ bundle }, the `npx vibetrace` path).
 * There is NO fabricated/synthetic project data anywhere.
 *
 * API (the handlers map 1:1 to these routes):
 *   GET  /api/registry      -> RegistrySummary[]  (sorted desc by buildScore, tie-break proof rank)
 *   GET  /api/bundle/:id     -> PublicLedgerBundle (full bundle for the story page)
 *   GET  /api/badge/:id.svg  -> image/svg+xml  (embeddable VibeScore badge; muted on unknown id)
 *   POST /api/submit         -> { entry } | 4xx { error }   body: { bundle }
 */

import { gunzipSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicLedgerBundle, VerifyAgainst0G } from "@vibetrace/schema";
import {
  isDisplayEligibleAttestation,
  substantiatedFlaggedCounts,
  verifyAgainst0GMismatch,
  worstVerdict
} from "./src/verdicts";

/**
 * The compiled @vibetrace/score / @vibetrace/schema dist files use extensionless
 * ESM relative imports. Node's native loader — which Vite uses to evaluate
 * vite.config.ts (and therefore the plugin that imports THIS module) — cannot
 * resolve those, so a top-level static `import` here would crash `vite build`.
 *
 * We instead load them through a lazily-resolved dynamic import the first time a
 * scoring call actually runs. Under tsx (server.ts) and under Vite's SSR graph
 * (the dev plugin) the dynamic import resolves fine; at config-LOAD time it is
 * never triggered, so the build no longer breaks. The result is cached.
 */
type ScoreApi = typeof import("@vibetrace/score");
type SchemaApi = typeof import("@vibetrace/schema");

export type ScoreFns = {
  scoreBundle: ScoreApi["scoreBundle"];
  hashPublicLedgerBundle: SchemaApi["hashPublicLedgerBundle"];
};

/**
 * A pluggable module loader. The default uses a plain dynamic `import()`, which
 * works under tsx (server.ts). The Vite dev plugin injects an ssrLoadModule-
 * backed loader instead, because Vite evaluates the plugin with Node's native
 * loader, which cannot resolve the compiled packages' extensionless ESM imports.
 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

const defaultLoader: ModuleLoader = (specifier) => import(specifier);

let scoreFns: ScoreFns | null = null;
let activeLoader: ModuleLoader = defaultLoader;

/**
 * Override how @vibetrace/score + @vibetrace/schema are resolved (e.g. with
 * Vite's `server.ssrLoadModule`). Call BEFORE createStore()/any scoring. Resets
 * the cached functions so the new loader is honored.
 */
export function setModuleLoader(loader: ModuleLoader): void {
  activeLoader = loader;
  scoreFns = null;
}

async function loadScoreFns(): Promise<ScoreFns> {
  if (scoreFns) return scoreFns;
  const [score, schema] = (await Promise.all([
    activeLoader("@vibetrace/score"),
    activeLoader("@vibetrace/schema")
  ])) as [ScoreApi, SchemaApi];
  scoreFns = { scoreBundle: score.scoreBundle, hashPublicLedgerBundle: schema.hashPublicLedgerBundle };
  return scoreFns;
}

// The leaderboard-row shape lives in ./src/registry-types so the server (this
// file) and the client (./src/registry.ts) share ONE definition and can never
// drift. Re-exported here so existing `from "./registry-core"` importers (the
// vite plugin, server.ts, the tests) keep working unchanged.
export type { RegistrySummary } from "./src/registry-types";
import type { RegistrySummary } from "./src/registry-types";

/** Persisted record: the summary plus the full bundle it was derived from. */
export type StoredEntry = RegistrySummary & { bundle: PublicLedgerBundle };

/** A framework-agnostic HTTP-ish result returned by every handler. */
export type CoreResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = resolve(HERE, ".vibetrace-registry.json");
const DEFAULT_SEED_DIR = resolve(HERE, "../../.vibetrace/public");
// A real project's public bundle (full artifact graph + snapshot) is hashes and paths — highly
// compressible. The CLI gzips the POST body, so the WIRE cap (maxSubmitBytes) governs the small
// compressed payload while the INFLATE cap (maxInflatedBytes) is the real RAM bound on the decoded
// JSON we parse. A modest wire cap therefore accepts an enormous raw bundle without per-user tuning,
// and the inflate cap (a fixed ceiling far above any real bundle) is the zip-bomb / OOM guard.
// Env-derived limits keep floors so production config can only RAISE them; test overrides (via
// createStore) intentionally bypass the floors so tests can use tiny caps without huge allocations.
const MIN_SUBMIT_BODY_MB = 5;
const DEFAULT_SUBMIT_BODY_MB = 32;
const MIN_INFLATED_BODY_MB = 16;
const DEFAULT_INFLATED_BODY_MB = 128;
const MIN_BUNDLE_ARRAY_ITEMS = 10_000;
const DEFAULT_BUNDLE_ARRAY_ITEMS = 400_000;

export type RegistryLimits = {
  /** Cap on the raw bytes read off the socket (the gzipped payload for modern clients). */
  maxSubmitBytes: number;
  /** Cap on the DECODED body the server parses — the real RAM bound / zip-bomb guard. */
  maxInflatedBytes: number;
  maxBundleArrayItems: number;
};

// Fail CLOSED on a present-but-invalid cap: a misconfigured DoS guard (e.g. "16m" instead of "16")
// must not silently fall through to the higher default. Absent/empty → the documented fallback.
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function registryLimitsFromEnv(): RegistryLimits {
  const submitMb = envNumber("VIBETRACE_REGISTRY_MAX_SUBMIT_MB", DEFAULT_SUBMIT_BODY_MB);
  const inflatedMb = envNumber("VIBETRACE_REGISTRY_MAX_INFLATED_MB", DEFAULT_INFLATED_BODY_MB);
  const arrayItems = envNumber("VIBETRACE_REGISTRY_MAX_ARRAY_ITEMS", DEFAULT_BUNDLE_ARRAY_ITEMS);
  return {
    maxSubmitBytes: Math.max(MIN_SUBMIT_BODY_MB, submitMb) * 1024 * 1024,
    maxInflatedBytes: Math.max(MIN_INFLATED_BODY_MB, inflatedMb) * 1024 * 1024,
    maxBundleArrayItems: Math.max(MIN_BUNDLE_ARRAY_ITEMS, arrayItems)
  };
}

function resolveRegistryLimits(overrides: Partial<RegistryLimits> = {}): RegistryLimits {
  const env = registryLimitsFromEnv();
  return {
    maxSubmitBytes: overrides.maxSubmitBytes ?? env.maxSubmitBytes,
    maxInflatedBytes: overrides.maxInflatedBytes ?? env.maxInflatedBytes,
    maxBundleArrayItems: overrides.maxBundleArrayItems ?? env.maxBundleArrayItems
  };
}
/** Cap total stored entries so unauthenticated submissions can't grow the store
 *  (and the on-disk JSON it rewrites every submit) without bound. */
const MAX_REGISTRY_ENTRIES = 1000;

// Bound CONCURRENT /api/submit handling: each accepted submit transiently holds the decoded body +
// its parsed object graph in memory, so even two near-cap submits at once can OOM a small host.
// Defaults to 1 (serialize submits) — fail safe; raise via env only on a host with headroom.
// Module-level (single process). Excess submits are rejected with 429 by the adapters.
const MAX_ACTIVE_SUBMITS = Math.max(1, envNumber("VIBETRACE_REGISTRY_MAX_ACTIVE_SUBMITS", 1));
let activeSubmits = 0;

/** Try to reserve a submit slot. Returns false when MAX_ACTIVE_SUBMITS are already in flight; the
 *  caller must then 429. Pair every `true` with exactly one releaseSubmitSlot() in a finally. */
export function tryAcquireSubmitSlot(): boolean {
  if (activeSubmits >= MAX_ACTIVE_SUBMITS) return false;
  activeSubmits += 1;
  return true;
}

export function releaseSubmitSlot(): void {
  activeSubmits = Math.max(0, activeSubmits - 1);
}
const HEX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes = registryLimitsFromEnv().maxSubmitBytes) {
    super(`Request body too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB)`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function isRequestBodyTooLargeError(err: unknown): err is RequestBodyTooLargeError {
  return err instanceof RequestBodyTooLargeError;
}

/** Thrown when a request body is declared compressed but cannot be decompressed (malformed payload). */
export class RequestBodyDecodeError extends Error {
  constructor(message = "Could not decode the request body") {
    super(message);
    this.name = "RequestBodyDecodeError";
  }
}

export function isRequestBodyDecodeError(err: unknown): err is RequestBodyDecodeError {
  return err instanceof RequestBodyDecodeError;
}

/** Read the raw request bytes off the socket, aborting as soon as the WIRE cap is exceeded so an
 *  oversized upload never fully buffers. Returns the (possibly compressed) bytes for decodeSubmitBody. */
export async function readLimitedRequestBodyBytes(
  stream: AsyncIterable<unknown>,
  maxBytes = registryLimitsFromEnv().maxSubmitBytes
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

/** Back-compat string reader (uncompressed bodies). New callers should prefer the bytes reader +
 *  decodeSubmitBody so they get gzip support and a separate inflate cap. */
export async function readLimitedRequestBody(
  stream: AsyncIterable<unknown>,
  maxBytes = registryLimitsFromEnv().maxSubmitBytes
): Promise<string> {
  return (await readLimitedRequestBodyBytes(stream, maxBytes)).toString("utf8");
}

/** Decode a submission body to its JSON text. gzip/deflate payloads (Content-Encoding) are inflated
 *  with a hard output cap so a small compressed body can never expand into an unbounded allocation
 *  (zip-bomb guard). Uncompressed bodies pass through, still bounded by maxInflatedBytes. */
export function decodeSubmitBody(
  body: Buffer,
  contentEncoding: string | undefined,
  maxInflatedBytes = registryLimitsFromEnv().maxInflatedBytes
): string {
  const encoding = (contentEncoding ?? "").toLowerCase().trim();
  if (encoding === "gzip" || encoding === "deflate") {
    let out: Buffer;
    try {
      out =
        encoding === "gzip"
          ? gunzipSync(body, { maxOutputLength: maxInflatedBytes })
          : inflateSync(body, { maxOutputLength: maxInflatedBytes });
    } catch (err) {
      // zlib throws a RangeError (ERR_BUFFER_TOO_LARGE) DURING expansion once output would exceed
      // maxOutputLength — so peak allocation is bounded, not just the final length.
      if (err instanceof RangeError) throw new RequestBodyTooLargeError(maxInflatedBytes);
      throw new RequestBodyDecodeError(`Could not decompress ${encoding} request body`);
    }
    return out.toString("utf8");
  }
  if (encoding && encoding !== "identity") {
    throw new RequestBodyDecodeError(`Unsupported Content-Encoding: ${encoding}`);
  }
  if (body.length > maxInflatedBytes) throw new RequestBodyTooLargeError(maxInflatedBytes);
  return body.toString("utf8");
}

/** Read the request body off the socket and decode it to JSON text. The WIRE read cap depends on the
 *  encoding: a compressed payload is bounded by the small maxSubmitBytes; an identity (uncompressed)
 *  body IS the final content, so it is bounded by the larger maxInflatedBytes — preserving the
 *  uncompressed ceiling for older clients that don't gzip. Throws RequestBodyTooLargeError (→413) or
 *  RequestBodyDecodeError (→400). */
export async function readAndDecodeSubmitBody(
  stream: AsyncIterable<unknown>,
  contentEncoding: string | undefined,
  limits: Pick<RegistryLimits, "maxSubmitBytes" | "maxInflatedBytes">
): Promise<string> {
  const enc = (contentEncoding ?? "").toLowerCase().trim();
  const compressed = enc === "gzip" || enc === "deflate";
  // Reject an unsupported encoding BEFORE reading the body, so a mislabeled payload can't first consume
  // up to maxInflatedBytes only to be rejected.
  if (enc && !compressed && enc !== "identity") {
    throw new RequestBodyDecodeError(`Unsupported Content-Encoding: ${enc}`);
  }
  const wireCap = compressed ? limits.maxSubmitBytes : limits.maxInflatedBytes;
  const bytes = await readLimitedRequestBodyBytes(stream, wireCap);
  return decodeSubmitBody(bytes, contentEncoding, limits.maxInflatedBytes);
}

/* ── store: a small object that owns the in-memory entries + its paths ── */

export type RegistryStore = {
  entries: StoredEntry[];
  storePath: string;
  seedDir: string;
  limits: RegistryLimits;
};

export type CreateStoreOptions = {
  /** Override the persistence file path (defaults next to this module). */
  storePath?: string;
  /** Override the seed directory (defaults to <repo>/.vibetrace/public). */
  seedDir?: string;
  /** Override submission caps, primarily for focused tests. */
  limits?: Partial<RegistryLimits>;
};

/* ── persistence (created lazily; tolerant of a missing/empty file) ── */

function loadEntries(storePath: string): StoredEntry[] {
  if (!existsSync(storePath)) return [];
  try {
    const raw = readFileSync(storePath, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // FIX (stale-summary bypass): the persisted summary fields are NOT trusted on
    // load. A row written before the attestation gate was hardened — or one a host
    // hand-edited — could carry `teeVerified: true` while its underlying bundle's
    // attestation does NOT recover. We RE-DERIVE the attested display fields from
    // each entry's own bundle (the SAME pure helper deriveSummary uses), so a
    // stale/forged `teeVerified` can never survive a load and light up a pill or the
    // marquee. Non-attested fields (score/tier) are left as persisted — only the
    // trust-gate fields are reconciled here.
    return (parsed as StoredEntry[]).map(reconcileEntryAttestation);
  } catch {
    // Corrupt store → start fresh rather than crash the host.
    return [];
  }
}

/**
 * Re-derive a stored entry's attested display fields (teeVerified, attestedVerdict,
 * substantiatedClaims) from its own bundle, overriding whatever summary value was
 * persisted. Pure + sync (deriveAttestedFields does no scoring). If the bundle is
 * missing/malformed we fail CLOSED — drop teeVerified to false rather than trust the
 * persisted flag. This is the gate that stops a stale/forged `teeVerified` from
 * bypassing the hardened recovery check on load.
 */
function reconcileEntryAttestation(entry: StoredEntry): StoredEntry {
  const bundle = (entry as { bundle?: unknown }).bundle;
  if (!isPublicLedgerBundle(bundle)) {
    return { ...entry, teeVerified: false };
  }
  const attested = deriveAttestedFields(bundle);
  return {
    ...entry,
    teeVerified: attested.teeVerified,
    attestedVerdict: attested.attestedVerdict,
    substantiatedClaims: attested.substantiatedClaims
  };
}

export function writeJsonFileAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function persist(store: RegistryStore): void {
  writeJsonFileAtomic(store.storePath, store.entries);
}

/* ── bundle → summary derivation (pure; deterministic) ── */

/** Structural check that an unknown value is a usable PublicLedgerBundle. */
export function isPublicLedgerBundle(value: unknown): value is PublicLedgerBundle {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  const publicGraph = b.publicGraph as Record<string, unknown> | undefined;
  return (
    b.manifest != null &&
    typeof b.manifest === "object" &&
    publicGraph != null &&
    typeof publicGraph === "object" &&
    Array.isArray(publicGraph.nodes) &&
    Array.isArray(publicGraph.edges) &&
    b.verifierSummary != null &&
    typeof b.verifierSummary === "object" &&
    Array.isArray(b.evidenceBadges) &&
    b.storageAnchor != null &&
    typeof b.storageAnchor === "object" &&
    b.chainAnchor != null &&
    typeof b.chainAnchor === "object"
  );
}

function validateHashField(path: string, value: unknown): string | null {
  if (typeof value !== "string" || !HEX_HASH_RE.test(value)) {
    return `${path} must be a 0x-prefixed 64-character hex hash`;
  }
  return null;
}

function collectHashValidationErrors(bundle: PublicLedgerBundle): string[] {
  const errors: string[] = [];
  const add = (path: string, value: unknown) => {
    const error = validateHashField(path, value);
    if (error) errors.push(error);
  };

  add("manifest.snapshotRoot", bundle.manifest.snapshotRoot);
  add("manifest.traceRoot", bundle.manifest.traceRoot);
  add("manifest.graphRoot", bundle.manifest.graphRoot);
  add("manifest.publicBundleHash", bundle.manifest.publicBundleHash);
  add("publicGraph.canonicalHash", bundle.publicGraph.canonicalHash);
  add("verifierSummary.requestHash", bundle.verifierSummary.requestHash);
  add("verifierSummary.responseHash", bundle.verifierSummary.responseHash);
  add("verifierSummary.outputHash", bundle.verifierSummary.outputHash);
  add("storageAnchor.rootHash", bundle.storageAnchor.rootHash);
  add("chainAnchor.txHash", bundle.chainAnchor.txHash);
  add("chainAnchor.manifestHash", bundle.chainAnchor.manifestHash);

  bundle.publicGraph.nodes.forEach((node, index) => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    if (node.type === "TraceSpan") {
      add(`publicGraph.nodes[${index}].data.promptHash`, data.promptHash);
      add(`publicGraph.nodes[${index}].data.responseHash`, data.responseHash);
    }
    if (node.type === "FileVersion") {
      add(`publicGraph.nodes[${index}].data.hash`, data.hash);
    }
    if (node.type === "CommitSnapshot" || node.type === "ReleaseSnapshot") {
      const files = Array.isArray(data.files) ? data.files : [];
      files.forEach((file, fileIndex) => {
        const hash = file && typeof file === "object" ? (file as Record<string, unknown>).hash : undefined;
        add(`publicGraph.nodes[${index}].data.files[${fileIndex}].hash`, hash);
      });
    }
  });

  return errors;
}

function validatePostedBundle(store: RegistryStore, bundle: PublicLedgerBundle): string | null {
  const { maxBundleArrayItems } = store.limits;
  if (bundle.publicGraph.nodes.length > maxBundleArrayItems) {
    return `Too many publicGraph.nodes entries (max ${maxBundleArrayItems})`;
  }
  if (bundle.publicGraph.edges.length > maxBundleArrayItems) {
    return `Too many publicGraph.edges entries (max ${maxBundleArrayItems})`;
  }
  if (bundle.evidenceBadges.length > maxBundleArrayItems) {
    return `Too many evidenceBadges entries (max ${maxBundleArrayItems})`;
  }

  const hashErrors = collectHashValidationErrors(bundle);
  return hashErrors[0] ?? null;
}

/** Distinct tool·model pairs from the bundle's TraceSpan nodes, in first-seen order. */
function distinctTools(bundle: PublicLedgerBundle): { tool: string; model: string }[] {
  const seen = new Set<string>();
  const out: { tool: string; model: string }[] = [];
  for (const node of bundle.publicGraph.nodes) {
    if (node.type !== "TraceSpan") continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const tool = String(data.tool ?? "tool");
    const model = String(data.model ?? "model");
    const key = `${tool}·${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tool, model });
  }
  return out;
}

/** Best-effort repo label: prefer the commit/branch, else the URL host+path. */
function deriveRepo(bundle: PublicLedgerBundle, sourceUrl?: string): string {
  const repo = bundle.manifest.repo ?? ({} as PublicLedgerBundle["manifest"]["repo"]);
  if (repo.commit) {
    return repo.branch ? `${repo.commit} (${repo.branch})` : repo.commit;
  }
  if (repo.root) return repo.root;
  if (sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      return `${u.host}${u.pathname}`;
    } catch {
      return sourceUrl;
    }
  }
  return "unknown";
}

/** A stable, URL-safe id for an entry: the bundle hash without the 0x prefix. */
function idForHash(bundleHash: string): string {
  return bundleHash.replace(/^0x/, "");
}

/**
 * Derive a RegistrySummary from a real bundle. `submittedAt` is supplied by the
 * caller (server-side display time) so this function stays deterministic.
 */
export async function deriveSummary(
  bundle: PublicLedgerBundle,
  submittedAt: string,
  sourceUrl?: string
): Promise<RegistrySummary> {
  const { scoreBundle, hashPublicLedgerBundle } = await loadScoreFns();
  const score = scoreBundle(bundle);
  const bundleHash = hashPublicLedgerBundle(bundle);
  const nodes = bundle.publicGraph.nodes;
  const attested = deriveAttestedFields(bundle);
  return {
    id: idForHash(bundleHash),
    project: bundle.manifest.project?.name ?? "Untitled",
    repo: deriveRepo(bundle, sourceUrl),
    tools: distinctTools(bundle),
    vibeScore: score.vibeScore,
    tier: score.tier,
    tierLabel: score.tierLabel,
    seal: score.integrity.seal,
    anchored: score.integrity.anchored,
    scoreVersion: score.scoreVersion,
    buildScore: score.buildScore,
    buildTier: score.buildTier,
    buildTierLabel: score.buildTierLabel,
    proofLabel: score.proof.label,
    proofRank: score.proof.rank,
    trustWeightedScore: score.trustWeightedScore,
    fileCount: nodes.filter((n) => n.type === "FileVersion").length,
    verifiedClaims: bundle.evidenceBadges.filter((b) => b.status === "verified").length,
    teeVerified: attested.teeVerified,
    attestedVerdict: attested.attestedVerdict,
    substantiatedClaims: attested.substantiatedClaims,
    submittedAt,
    bundleHash
  };
}

/**
 * Derive the attested-provenance display fields from a bundle's verifier run.
 * Pure + deterministic; never touches scoring. `attestedVerdict` is the WORST
 * per-claim verdict so an `inflated`/`unsupported` honestly downgrades the
 * leaderboard headline (spec §11).
 *
 * Source of truth = `verifierSummary.verdicts` (the per-claim verdicts under the
 * tamper hash; TEE-execution-attested + relayer-transported, NOT content-signed)
 * via the SAME shared helpers the story card uses (see
 * ./src/verdicts). This is deliberate: the leaderboard headline and the story
 * seal word are derived from one source, so they can never disagree.
 * `evidenceBadges[].verdict` is only a per-badge display mirror of these —
 * never read here.
 */
function deriveAttestedFields(bundle: PublicLedgerBundle): {
  teeVerified: boolean;
  attestedVerdict: "substantiated" | "inflated" | "unsupported" | null;
  substantiatedClaims: number;
} {
  const verifier = bundle.verifierSummary as PublicLedgerBundle["verifierSummary"] & {
    attestation?: {
      processResponseValid?: boolean;
      attests?: string;
      scheme?: string;
      signingAddress?: string;
      signature?: string;
      signedDigest?: string;
    };
  };
  const att = verifier.attestation;
  // TEE-EXECUTION attested: the SHARED shape gate (isDisplayEligibleAttestation — 0g-teeml scheme,
  // `attests: "tee-execution"`, passing processResponse, non-empty signer/signature/signedDigest;
  // identical to the story-page seal so the surfaces can never disagree), the 0g-compute provider,
  // AND fail-closed on the 0G read-back: if a verifyAgainst0G sidecar is present, a storage/chain
  // mismatch downgrades teeVerified exactly like the story seal cracks (viewer.ts sealState). This
  // flag means an acknowledged TEE signer EXECUTED inference — NOT that the verdict content was signed.
  const v0gSidecar = (bundle as PublicLedgerBundle & { verifyAgainst0G?: VerifyAgainst0G }).verifyAgainst0G;
  const teeVerified =
    verifier.provider === "0g-compute" &&
    isDisplayEligibleAttestation(att) &&
    !verifyAgainst0GMismatch(v0gSidecar);

  const attestedVerdict = worstVerdict(verifier.verdicts);
  const substantiatedClaims = substantiatedFlaggedCounts(verifier.verdicts).substantiated;

  return { teeVerified, attestedVerdict, substantiatedClaims };
}

function toSummary(entry: StoredEntry): RegistrySummary {
  const { bundle: _bundle, ...summary } = entry;
  return summary;
}

function sortedSummaries(entries: StoredEntry[]): RegistrySummary[] {
  // v2: rank by intrinsic buildScore, tie-break by proof strength. Fallbacks keep
  // any pre-v2 persisted entries (which lack buildScore/proofRank) sortable.
  return entries.map(toSummary).sort(
    (a, b) =>
      (b.buildScore ?? b.vibeScore) - (a.buildScore ?? a.vibeScore) ||
      (b.proofRank ?? 0) - (a.proofRank ?? 0) ||
      b.vibeScore - a.vibeScore
  );
}

function anchorIdentity(bundle: PublicLedgerBundle): string | null {
  const chain = bundle.chainAnchor;
  if (chain?.txHash && HEX_HASH_RE.test(chain.txHash)) {
    return `chain:${chain.provider}:${chain.chainId}:${chain.txHash.toLowerCase()}`;
  }

  const storage = bundle.storageAnchor;
  if (storage?.uri && storage.rootHash && HEX_HASH_RE.test(storage.rootHash)) {
    return `storage:${storage.provider}:${storage.uri}:${storage.rootHash.toLowerCase()}`;
  }

  return null;
}

function fileVersionHashes(bundle: PublicLedgerBundle): Set<string> {
  const hashes = new Set<string>();
  for (const node of bundle.publicGraph.nodes) {
    if (node.type !== "FileVersion") continue;
    const hash = ((node.data ?? {}) as Record<string, unknown>).hash;
    if (typeof hash === "string" && HEX_HASH_RE.test(hash)) hashes.add(hash.toLowerCase());
  }
  return hashes;
}

function hasFileVersionHashOverlap(left: PublicLedgerBundle, right: PublicLedgerBundle): boolean {
  const leftHashes = fileVersionHashes(left);
  if (leftHashes.size === 0) return false;
  for (const hash of fileVersionHashes(right)) {
    if (leftHashes.has(hash)) return true;
  }
  return false;
}

/**
 * Fraction of the SMALLER bundle's file hashes that the two bundles share.
 * Used to gate repo-root dedup: a re-publish of the same repo overlaps ~fully,
 * whereas an attacker who only knows a victim's repo root + a few public file
 * hashes cannot reach the threshold — so they can't hijack/overwrite the row.
 */
function fileOverlapRatio(left: PublicLedgerBundle, right: PublicLedgerBundle): number {
  const l = fileVersionHashes(left);
  const r = fileVersionHashes(right);
  if (l.size === 0 || r.size === 0) return 0;
  let common = 0;
  for (const hash of r) if (l.has(hash)) common += 1;
  return common / Math.min(l.size, r.size);
}

/** Min share of files that must match for two bundles to be the "same repo". */
const REPO_DEDUP_MIN_OVERLAP = 0.5;

/** Stable per-repo identity: the absolute repo root recorded in the manifest. */
function repoKey(bundle: PublicLedgerBundle): string | null {
  const root = bundle.manifest.repo?.root;
  return typeof root === "string" && root.length > 0 ? root : null;
}

function duplicateEntryIndex(entries: StoredEntry[], entry: StoredEntry): number {
  const nextAnchor = anchorIdentity(entry.bundle);
  const nextRepo = repoKey(entry.bundle);
  return entries.findIndex((existing) => {
    if (existing.bundleHash === entry.bundleHash) return true;
    const existingAnchor = anchorIdentity(existing.bundle);
    if (
      existingAnchor != null &&
      nextAnchor != null &&
      existingAnchor === nextAnchor &&
      hasFileVersionHashOverlap(existing.bundle, entry.bundle)
    ) {
      return true;
    }
    // One entry per repo: a re-published build from the same repo root (with
    // overlapping file hashes) replaces the older row. Dev anchors mint a fresh
    // synthetic txHash each run, so the anchor rule above can't catch re-runs —
    // without this, the board accumulates a duplicate per `vibetrace` invocation.
    const existingRepo = repoKey(existing.bundle);
    return (
      nextRepo != null &&
      existingRepo === nextRepo &&
      fileOverlapRatio(existing.bundle, entry.bundle) >= REPO_DEDUP_MIN_OVERLAP
    );
  });
}

/* ── seed (real .vibetrace/public bundles only) ── */

/**
 * If the store is empty, score every real published bundle under the seed
 * directory and persist them. A missing/empty directory is fine — an empty
 * registry is a valid state.
 */
async function seedIfEmpty(store: RegistryStore): Promise<void> {
  if (store.entries.length > 0) return;
  if (!existsSync(store.seedDir)) return;

  let files: string[];
  try {
    files = readdirSync(store.seedDir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  const seeded: StoredEntry[] = [];
  const seenHash = new Set<string>();
  // Deterministic, server-side display time for the seed.
  const seedTime = "2026-06-17T16:08:00.000Z";

  for (const file of files.sort()) {
    try {
      const raw = readFileSync(join(store.seedDir, file), "utf8");
      const parsed = JSON.parse(raw);
      if (!isPublicLedgerBundle(parsed)) continue;
      const bundle = parsed as PublicLedgerBundle;
      const summary = await deriveSummary(bundle, seedTime);
      if (seenHash.has(summary.bundleHash)) continue;
      seenHash.add(summary.bundleHash);
      const entry: StoredEntry = { ...summary, bundle };
      // Collapse multiple published bundles of the SAME repo (e.g. several
      // .vibetrace/public/<hash>.json from successive runs) to one row — keep
      // the highest-scoring build for that repo.
      const dup = duplicateEntryIndex(seeded, entry);
      if (dup >= 0) {
        const delta = (entry.buildScore ?? entry.vibeScore) - (seeded[dup].buildScore ?? seeded[dup].vibeScore);
        if (delta > 0 || (delta === 0 && (entry.proofRank ?? 0) > (seeded[dup].proofRank ?? 0))) {
          seeded[dup] = entry;
        }
      } else {
        seeded.push(entry);
      }
    } catch {
      // Skip unreadable / malformed seed files; keep going.
      continue;
    }
  }

  if (seeded.length > 0) {
    store.entries = seeded;
    persist(store);
  }
}

/**
 * Build the registry store: load from disk, seed from .vibetrace/public if
 * empty, and return the hydrated store. The single entry point both adapters
 * call at startup.
 */
export async function createStore(opts: CreateStoreOptions = {}): Promise<RegistryStore> {
  const store: RegistryStore = {
    entries: [],
    storePath: opts.storePath ?? DEFAULT_STORE_PATH,
    seedDir: opts.seedDir ?? DEFAULT_SEED_DIR,
    limits: resolveRegistryLimits(opts.limits)
  };
  store.entries = loadEntries(store.storePath);
  await seedIfEmpty(store);
  return store;
}

/* ── badge (embeddable VibeScore SVG) ── */

/**
 * Tier → flat-badge fill + readable text colour. MUST match the app's
 * leaderboard tier stamps (see styles.css --color-* tokens):
 *   S/A → lime #c6f135 (dark text) · B → blue #1d4ed8 (white) ·
 *   C → sun #ffc400 (dark) · D → coral #fb4d26 (DARK ink text).
 *
 * Tier D uses INK (#0b0b0f) text on coral, NOT white: white-on-coral is only
 * ~3.39:1 (fails WCAG AA), whereas ink-on-coral is ~6.0:1 and legible. The
 * app's D-tier stamps (leaderboard seal pill, landing tier ladder, viewer
 * TIER_BG) are aligned to the same ink-on-coral so the badge stays consistent.
 */
export function tierBadgeColors(tier: string): { bg: string; fg: string } {
  switch (tier) {
    case "S":
    case "A":
      return { bg: "#c6f135", fg: "#0b0b0f" };
    case "B":
      return { bg: "#1d4ed8", fg: "#ffffff" };
    case "C":
      return { bg: "#ffc400", fg: "#0b0b0f" };
    case "D":
      return { bg: "#fb4d26", fg: "#0b0b0f" };
    default:
      return { bg: "#9aa0a6", fg: "#0b0b0f" };
  }
}

/** XML-escape text that will be rendered inside the SVG. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Rough advance-width estimate for the bold system sans we render with.
 * Good enough to size the right segment so text never clips. Per-char widths
 * at font-size 11px-ish (we render at 11.5/12px); narrow chars get less.
 */
function estimateTextWidth(text: string, perChar = 7.2): number {
  let w = 0;
  for (const ch of text) {
    if (ch === " " || ch === "·" || ch === "i" || ch === "l" || ch === "." || ch === "!") w += perChar * 0.45;
    else if (ch === "✓" || ch === "W" || ch === "M") w += perChar * 1.25;
    else w += perChar;
  }
  return w;
}

const BADGE_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Build the FLAT two-segment badge SVG. Left = dark ink "vibescore" label,
 * right = tier-coloured "{✓?} {tier} · {score} · 0G". Thin dark border for the
 * Neo-Brutal hard edge. All interpolated text is XML-escaped.
 */
export function flatBadgeSvg(opts: {
  label: string;
  value: string;
  bg: string;
  fg: string;
}): string {
  const H = 30;
  const padX = 9;
  const labelText = opts.label;
  const valueText = opts.value;
  const labelW = Math.ceil(estimateTextWidth(labelText) + padX * 2);
  const valueW = Math.ceil(estimateTextWidth(valueText) + padX * 2);
  const W = labelW + valueW;

  const label = escapeXml(labelText);
  const value = escapeXml(valueText);
  const labelMid = labelW / 2;
  const valueMid = labelW + valueW / 2;
  const textY = 19.5;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}: ${value}">` +
    `<title>${label}: ${value}</title>` +
    // segments
    `<rect x="0" y="0" width="${labelW}" height="${H}" fill="#0b0b0f"/>` +
    `<rect x="${labelW}" y="0" width="${valueW}" height="${H}" fill="${opts.bg}"/>` +
    // hard divider + thin dark border (Neo-Brutal)
    `<rect x="${labelW - 0.75}" y="0" width="1.5" height="${H}" fill="#0b0b0f"/>` +
    `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" ` +
    `stroke="#0b0b0f" stroke-width="1.5"/>` +
    // text
    `<g font-family="${BADGE_FONT}" font-size="12" font-weight="700" ` +
    `text-anchor="middle" dominant-baseline="middle">` +
    `<text x="${labelMid}" y="${textY}" fill="#fbf7ec" letter-spacing="0.2">${label}</text>` +
    `<text x="${valueMid}" y="${textY}" fill="${opts.fg}">${value}</text>` +
    `</g>` +
    `</svg>`
  );
}

/**
 * Bolder square "stamp" variant (optional ?style=stamp). For an
 * anchored-verified entry a leading ✓ is prepended to the value segment, so the
 * stamp carries the same verification mark the flat badge shows.
 */
export function stampBadgeSvg(opts: {
  tier: string;
  value: string;
  bg: string;
  fg: string;
  check?: boolean;
}): string {
  const S = 30;
  const check = opts.check ? "✓ " : "";
  const valueText = `${check}${opts.value}`;
  const valueW = Math.ceil(estimateTextWidth(valueText) + 18);
  const tierW = 34;
  const W = tierW + valueW;
  const tier = escapeXml(opts.tier);
  const value = escapeXml(valueText);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${S}" ` +
    `viewBox="0 0 ${W} ${S}" role="img" aria-label="vibescore tier ${tier}: ${value}">` +
    `<title>vibescore ${tier}: ${value}</title>` +
    `<rect x="0" y="0" width="${tierW}" height="${S}" fill="${opts.bg}"/>` +
    `<rect x="${tierW}" y="0" width="${valueW}" height="${S}" fill="#0b0b0f"/>` +
    `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${S - 1.5}" fill="none" ` +
    `stroke="#0b0b0f" stroke-width="1.5"/>` +
    `<g font-family="${BADGE_FONT}" text-anchor="middle" dominant-baseline="middle">` +
    `<text x="${tierW / 2}" y="20" font-size="17" font-weight="800" fill="${opts.fg}">${tier}</text>` +
    `<text x="${tierW + valueW / 2}" y="19.5" font-size="12" font-weight="700" fill="#fbf7ec">${value}</text>` +
    `</g>` +
    `</svg>`
  );
}

/** A muted "unverified" badge for unknown/missing ids (never a broken image). */
export function mutedBadgeSvg(): string {
  return flatBadgeSvg({
    label: "vibescore",
    value: "· unverified",
    bg: "#e6e2d6",
    fg: "#5b5b5b"
  });
}

/**
 * Render the badge SVG for a stored entry. Reads the entry's RegistrySummary
 * fields directly — NO re-scoring. Reflects the real stored tier/score/seal.
 */
export function badgeForEntry(entry: StoredEntry, style: string): string {
  // v2: the badge shows the BUILD tier/score (intrinsic quality); proof is a
  // compact token (0G / dev / local / broken), not an always-on "· 0G" claim.
  const tier = String(entry.buildTier ?? entry.tier ?? "?");
  const scoreNum = Number.isFinite(entry.buildScore) ? entry.buildScore : entry.vibeScore;
  const score = Number.isFinite(scoreNum) ? String(scoreNum) : "?";
  const { bg, fg } = tierBadgeColors(tier);
  const independentlyVerified = entry.seal === "anchored-verified";
  const proofToken =
    entry.seal === "broken"
      ? "broken"
      : entry.anchored
        ? "0G"
        : typeof entry.proofLabel === "string" && entry.proofLabel.startsWith("Dev anchor")
          ? "dev"
          : "local";

  if (style === "stamp") {
    return stampBadgeSvg({ tier, value: `${score} · ${proofToken}`, bg, fg, check: independentlyVerified });
  }
  const check = independentlyVerified ? "✓ " : "";
  return flatBadgeSvg({
    label: "vibescore",
    value: `${check}${tier} · ${score} · ${proofToken}`,
    bg,
    fg
  });
}

/**
 * Resolve the badge SVG for a raw badge-route id against a store's entries,
 * exactly as the GET /api/badge/:id.svg endpoint does: a known id (matched by
 * entry id OR full bundleHash) renders that entry's REAL stored tier/score (no
 * re-scoring); any unknown/empty id renders the muted "unverified" badge so
 * embedded READMEs never show a broken image. `rawId` is the route segment with
 * any trailing ".svg" already stripped. The single source of truth shared by
 * both adapters and the tests.
 */
export function renderBadgeForId(
  entries: StoredEntry[],
  rawId: string,
  style = "flat"
): string {
  const found = rawId
    ? entries.find((e) => e.id === rawId || e.bundleHash === rawId)
    : undefined;
  return found ? badgeForEntry(found, style) : mutedBadgeSvg();
}

/* ── pure request handlers (framework-agnostic) ── */

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function jsonResult(status: number, body: unknown): CoreResult {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** GET /api/registry → summaries sorted desc by buildScore (tie-break proof rank). */
export async function handleRegistry(store: RegistryStore): Promise<CoreResult> {
  return jsonResult(200, sortedSummaries(store.entries));
}

/** GET /api/bundle/:id → the full PublicLedgerBundle, or 404. */
export async function handleBundle(store: RegistryStore, id: string): Promise<CoreResult> {
  const found = store.entries.find((e) => e.id === id || e.bundleHash === id);
  if (!found) {
    return jsonResult(404, { error: `No bundle with id "${id}"` });
  }
  return jsonResult(200, found.bundle);
}

/**
 * GET /api/badge/:id(.svg) → an image/svg+xml badge. Always 200 (a muted
 * "unverified" badge for unknown ids) so embedded READMEs never break.
 */
export async function handleBadge(
  store: RegistryStore,
  rawId: string,
  style = "flat"
): Promise<CoreResult> {
  const svg = renderBadgeForId(store.entries, rawId, style);
  return {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-cache"
    },
    body: svg
  };
}

/**
 * POST /api/submit → { entry } | 4xx { error }.
 *
 * `jsonBody` is the already-read raw request body string. The only accepted
 * body shape is { bundle: PublicLedgerBundle } — the FULL bundle posted
 * directly by the CLI path. Public URL fetching is intentionally not supported.
 *
 * The bundle is validated, scored, deduped (exact hash or matching anchor plus
 * FileVersion hash overlap), and persisted.
 */
export async function handleSubmit(store: RegistryStore, jsonBody: string): Promise<CoreResult> {
  // jsonBody is the already-DECODED body (the adapter inflates gzip before calling), so it is bounded
  // by the inflate cap, not the wire cap. The wire cap was enforced upstream in readLimitedRequestBodyBytes.
  const { maxInflatedBytes } = store.limits;
  if (Buffer.byteLength(jsonBody, "utf8") > maxInflatedBytes) {
    return jsonResult(413, {
      error: `Request body too large (max ${Math.floor(maxInflatedBytes / (1024 * 1024))}MB)`
    });
  }

  // 1. Parse the request body.
  let body: Record<string, unknown>;
  try {
    body = jsonBody ? (JSON.parse(jsonBody) as Record<string, unknown>) : {};
  } catch {
    return jsonResult(400, { error: "Invalid JSON body" });
  }

  // 2. Resolve the directly-posted bundle. URL ingestion is intentionally gone:
  //    the CLI posts the full bundle, so the server has no fetch dependency.
  if (body.bundle == null) {
    return jsonResult(400, { error: "Missing bundle" });
  }
  const parsed = body.bundle;

  // 3. Validate it is a PublicLedgerBundle.
  if (!isPublicLedgerBundle(parsed)) {
    return jsonResult(400, { error: "Not a valid PublicLedgerBundle" });
  }
  const bundle = parsed as PublicLedgerBundle;
  const validationError = validatePostedBundle(store, bundle);
  if (validationError) {
    return jsonResult(400, { error: validationError });
  }

  // 4. Score + derive the summary (server-side display timestamp).
  let entry: StoredEntry;
  try {
    const summary = await deriveSummary(bundle, new Date().toISOString());
    entry = { ...summary, bundle };
  } catch (err) {
    return jsonResult(400, {
      error: `Unable to score bundle: ${err instanceof Error ? err.message : String(err)}`
    });
  }

  // 5. Dedupe by exact bundleHash, or by same anchor plus overlapping file hashes.
  const idx = duplicateEntryIndex(store.entries, entry);
  if (idx >= 0) {
    store.entries[idx] = entry;
  } else {
    if (store.entries.length >= MAX_REGISTRY_ENTRIES) {
      return jsonResult(429, { error: "Registry is at capacity; submission rejected." });
    }
    store.entries.push(entry);
  }
  persist(store);

  return jsonResult(200, { entry: toSummary(entry) });
}
