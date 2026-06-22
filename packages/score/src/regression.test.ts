import { describe, expect, it } from "vitest";
import { scoreBundle } from "./index";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

const fullCoverage = (extra?: Parameters<typeof makeBundle>[0]) =>
  makeBundle({
    anchored: true,
    independentVerifier: true,
    traces: [
      traceSpan({ spanId: "s1", tool: "codex", model: "gpt-5", artifactsProduced: ["a.ts"] }),
      traceSpan({ spanId: "s2", tool: "claude-code", model: "sonnet", artifactsProduced: ["b.ts"] }),
    ],
    snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }, { path: "b.ts", size: 500 }] })],
    claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["a", "b"] }],
    ...extra,
  });

describe("tier spread", () => {
  it("anchored + independent + full coverage ⇒ S", async () => {
    const r = scoreBundle(await fullCoverage());
    expect(r.tier).toBe("S");
    expect(r.integrity.seal).toBe("anchored-verified");
  });

  it("self-verified (local 0g-dev verifier) drops below anchored-verified", async () => {
    const indep = scoreBundle(await fullCoverage());
    const self = scoreBundle(await fullCoverage({ independentVerifier: false }));
    expect(self.vibeScore).toBeLessThan(indep.vibeScore);
    expect(self.integrity.verified).toBe(false);
  });

  it("unanchored full-coverage bundle is capped at C/D", async () => {
    const r = scoreBundle(await fullCoverage({ anchored: false }));
    expect(["C", "D"]).toContain(r.tier);
    expect(r.integrity.seal).toBe("self-published");
  });

  it("broken anchor ⇒ score 0 / tier D", async () => {
    const r = scoreBundle(await fullCoverage({ manifestHashOverride: "0x" + "9".repeat(64) }));
    expect(r.vibeScore).toBe(0);
    expect(r.tier).toBe("D");
  });
});

describe("properties", () => {
  it("Integrity=0 always yields score 0 (gate dominance)", async () => {
    const r = scoreBundle(await fullCoverage({ manifestHashOverride: "0x" + "3".repeat(64) }));
    expect(r.vibeScore).toBe(0);
  });

  it("adding more anchored AI-traced coverage never lowers the score", async () => {
    const low = scoreBundle(await makeBundle({
      anchored: true,
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }, { path: "b.ts", size: 500 }] })],
      claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["a", "b"] }],
    }));
    const high = scoreBundle(await makeBundle({
      anchored: true,
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts", "b.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }, { path: "b.ts", size: 500 }] })],
      claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["a", "b"] }],
    }));
    expect(high.vibeScore).toBeGreaterThanOrEqual(low.vibeScore);
  });
});
