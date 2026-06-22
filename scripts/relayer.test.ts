import { describe, expect, it, vi } from "vitest";
import {
  parseBearerToken,
  isAuthorized,
  RateLimiter,
  createRelayerHandler,
  createPublishHandler,
  type RelayerDeps,
  type PublishDeps
} from "./relayer";

describe("relayer bearer auth", () => {
  it("parses a Bearer token from the Authorization header", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("bearer abc123")).toBe("abc123");
    expect(parseBearerToken("Token abc123")).toBe(null);
    expect(parseBearerToken(undefined)).toBe(null);
    expect(parseBearerToken("Bearer ")).toBe(null);
  });

  it("authorizes only the exact-value token (constant-time digest compare, no length leak)", () => {
    expect(isAuthorized("Bearer secret", "secret")).toBe(true);
    // A longer token sharing a prefix is rejected (different value → different digest); the
    // comparison never short-circuits on length, so length is not leaked.
    expect(isAuthorized("Bearer secretX", "secret")).toBe(false);
    expect(isAuthorized("Bearer wrong6", "secret")).toBe(false);
    // A wrong token of a DIFFERENT length is still rejected (no length-equality precondition).
    expect(isAuthorized("Bearer x", "secret")).toBe(false);
    expect(isAuthorized(undefined, "secret")).toBe(false);
    // An empty configured token must NEVER authorize (fail closed).
    expect(isAuthorized("Bearer ", "")).toBe(false);
    expect(isAuthorized(undefined, "")).toBe(false);
  });
});

describe("relayer rate limiter (fixed window)", () => {
  it("allows up to `limit` per window per key, then blocks", () => {
    let now = 1_000;
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false); // third in window → blocked
    expect(rl.allow("b")).toBe(true); // separate key unaffected
    now += 1_001; // window rolls over
    expect(rl.allow("a")).toBe(true);
  });
});

describe("createRelayerHandler (funded key never leaves the relayer)", () => {
  function deps(over: Partial<RelayerDeps> = {}): RelayerDeps {
    return {
      authToken: "good-token",
      fundedKeyPresent: true,
      rateLimiter: new RateLimiter({ limit: 100, windowMs: 1_000 }),
      adjudicate: vi.fn(async () => ({
        verifierRun: {
          provider: "0g-compute",
          verdicts: [],
          verdictRoot: "0x" + "0".repeat(64),
          attestation: { scheme: "0g-teeml", processResponseValid: true, signingAddress: "0xsigner" }
        },
        evidenceBadges: [],
        signedText: JSON.stringify({ schema: "vibetrace.adjudication.v1", claims: [] })
      })),
      ...over
    };
  }

  it("rejects unauthenticated requests with 401 and never calls adjudicate", async () => {
    const d = deps();
    const handler = createRelayerHandler(d);
    const res = await handler({ headers: {}, clientId: "ip1", body: { graph: {} } });
    expect(res.status).toBe(401);
    expect(d.adjudicate).not.toHaveBeenCalled();
  });

  it("rate-limits an authorized but noisy client with 429", async () => {
    const d = deps({ rateLimiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    const handler = createRelayerHandler(d);
    const auth = { authorization: "Bearer good-token" };
    expect((await handler({ headers: auth, clientId: "ip1", body: { graph: {} } })).status).toBe(200);
    const blocked = await handler({ headers: auth, clientId: "ip1", body: { graph: {} } });
    expect(blocked.status).toBe(429);
  });

  it("fails closed with 503 when the funded key is absent", async () => {
    const d = deps({ fundedKeyPresent: false });
    const handler = createRelayerHandler(d);
    const res = await handler({ headers: { authorization: "Bearer good-token" }, clientId: "ip1", body: { graph: {} } });
    expect(res.status).toBe(503);
    expect(d.adjudicate).not.toHaveBeenCalled();
  });

  it("returns the canonical { verifierRun, evidenceBadges, signedText } and NEVER leaks key material", async () => {
    const d = deps();
    const handler = createRelayerHandler(d);
    const res = await handler({ headers: { authorization: "Bearer good-token" }, clientId: "ip1", body: { graph: {} } });
    expect(res.status).toBe(200);
    expect(res.body.verifierRun.attestation.processResponseValid).toBe(true);
    expect(typeof res.body.signedText).toBe("string");
    // The serialized response must not contain any private-key-shaped hex.
    expect(JSON.stringify(res.body)).not.toMatch(/private/i);
  });

  it("is OPEN when no token is configured (optional auth)", async () => {
    const d = deps({ authToken: "" });
    const handler = createRelayerHandler(d);
    const res = await handler({ headers: {}, clientId: "ip1", body: { graph: {} } });
    expect(res.status).toBe(200); // no token configured → unauthenticated request allowed
  });
});

describe("createPublishHandler (guarded funded receipt builder, not an open faucet)", () => {
  // A minimal well-formed pending bundle: the four required fields + a publicGraph.nodes array.
  function wellFormedBundle(over: { nodes?: unknown[]; edges?: unknown[] } = {}) {
    return {
      manifest: { schemaVersion: "vibetrace.v1" },
      publicGraph: {
        nodes: over.nodes ?? [{ id: "n1" }],
        edges: over.edges ?? [],
        redactionPolicy: "private-by-default",
        canonicalHash: "0x" + "0".repeat(64)
      },
      verifierSummary: { provider: "0g-compute", verdicts: [] },
      evidenceBadges: []
    };
  }

  function deps(over: Partial<PublishDeps> = {}): PublishDeps {
    return {
      authToken: "good-token",
      fundedKeyPresent: true,
      rateLimiter: new RateLimiter({ limit: 100, windowMs: 1_000 }),
      publish: vi.fn(async () => ({ ok: true })),
      ...over
    };
  }

  it("rejects unauthenticated requests with 401 and never anchors", async () => {
    const d = deps();
    const handler = createPublishHandler(d);
    const res = await handler({ headers: {}, clientId: "ip1", body: { pendingBundle: wellFormedBundle() } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the funded key is absent (no gas to spend)", async () => {
    const d = deps({ fundedKeyPresent: false });
    const handler = createPublishHandler(d);
    const res = await handler({
      headers: { authorization: "Bearer good-token" },
      clientId: "ip1",
      body: { pendingBundle: wellFormedBundle() }
    });
    expect(res.status).toBe(503);
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("rate-limits a noisy authorized client with 429 (gas-spend budget)", async () => {
    const d = deps({ rateLimiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    const handler = createPublishHandler(d);
    const auth = { authorization: "Bearer good-token" };
    const first = await handler({ headers: auth, clientId: "ip1", body: { pendingBundle: wellFormedBundle() } });
    expect(first.status).toBe(200);
    const blocked = await handler({ headers: auth, clientId: "ip1", body: { pendingBundle: wellFormedBundle() } });
    expect(blocked.status).toBe(429);
  });

  it("rejects a malformed body with 400 and never anchors", async () => {
    const d = deps();
    const handler = createPublishHandler(d);
    const auth = { authorization: "Bearer good-token" };
    // missing pendingBundle entirely
    expect((await handler({ headers: auth, clientId: "ip1", body: { graph: {} } })).status).toBe(400);
    // pendingBundle present but missing publicGraph (and its nodes array)
    const noGraph = await handler({
      headers: auth,
      clientId: "ip2",
      body: { pendingBundle: { manifest: {}, verifierSummary: {}, evidenceBadges: [] } }
    });
    expect(noGraph.status).toBe(400);
    expect(noGraph.body).toEqual({ error: "invalid publish request" });
    // publicGraph present but nodes is not an array
    const badNodes = await handler({
      headers: auth,
      clientId: "ip3",
      body: { pendingBundle: { manifest: {}, publicGraph: { nodes: "nope" }, verifierSummary: {}, evidenceBadges: [] } }
    });
    expect(badNodes.status).toBe(400);
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("rejects an over-cap graph with 413 (nodes exceed the cap) and never anchors", async () => {
    const d = deps({ maxGraphNodes: 2 });
    const handler = createPublishHandler(d);
    const tooBig = wellFormedBundle({ nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] }); // 3 > cap 2
    const res = await handler({
      headers: { authorization: "Bearer good-token" },
      clientId: "ip1",
      body: { pendingBundle: tooBig }
    });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "graph too large" });
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("happy path: a well-formed bundle anchors and returns { bundle }", async () => {
    const d = deps(); // stub publish returns { ok: true }
    const handler = createPublishHandler(d);
    const pendingBundle = wellFormedBundle();
    const res = await handler({
      headers: { authorization: "Bearer good-token" },
      clientId: "ip1",
      body: { pendingBundle }
    });
    expect(res).toEqual({ status: 200, body: { bundle: { ok: true } } });
    expect(d.publish).toHaveBeenCalledTimes(1);
    // The handler forwards the validated pendingBundle (not the outer envelope) to publish.
    expect((d.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(pendingBundle);
  });

  it("returns a sanitized 502 when publish throws and NEVER leaks internal detail", async () => {
    const leaky = new Error("VIBETRACE_0G_COMPUTE_PRIVATE_KEY=0xdeadbeef anchoring failed");
    const d = deps({ publish: vi.fn(async () => { throw leaky; }) });
    const handler = createPublishHandler(d);
    // The handler logs server-side for ops; suppress it so the test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handler({
      headers: { authorization: "Bearer good-token" },
      clientId: "ip1",
      body: { pendingBundle: wellFormedBundle() }
    });
    errSpy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "publish failed" });
    // No key material / internal message leaks into the client-facing response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/private/i);
    expect(serialized).not.toMatch(/deadbeef/i);
    expect(serialized).not.toContain("anchoring failed");
  });
});
