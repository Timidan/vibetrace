import { describe, expect, it } from "vitest";
import { scoreBundle } from "./index";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

const sampleLike = () =>
  makeBundle({
    anchored: true,
    independentVerifier: true,
    traces: [traceSpan({ spanId: "span-sample-1", artifactsProduced: ["packages/schema/src/index.ts"] })],
    snapshots: [
      snapshot({
        commit: "c1",
        files: [
          { path: "packages/schema/src/index.ts", size: 5450 },
          ...Array.from({ length: 44 }, (_, i) => ({ path: `other/f${i}.ts`, size: 800 + i })),
        ],
      }),
    ],
    claims: [{ claimId: "claim-synthetic-a", text: "AI build", selectors: ["packages"] }],
  });

describe("scoreBundle", () => {
  it("scores the sample-like bundle around tier C with an anchored-verified seal", async () => {
    const r = scoreBundle(await sampleLike());
    expect(r.vibeScore).toBeGreaterThanOrEqual(25);
    expect(r.vibeScore).toBeLessThanOrEqual(45);
    expect(r.tier).toBe("C");
    expect(r.integrity.seal).toBe("anchored-verified");
    expect(r.subScores.verifiedAIDepth).toBeNull();
    expect(r.badge.label).toBe("AI-Assisted, Unverified");
  });

  it("gate dominance: a manifest mismatch collapses the score to 0", async () => {
    const r = scoreBundle(await makeBundle({ ...({ traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts"] })], snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }] })] }), anchored: true, manifestHashOverride: "0x" + "2".repeat(64) }));
    expect(r.vibeScore).toBe(0);
    expect(r.tier).toBe("D");
    expect(r.flags).toContain("manifest-mismatch");
  });

  it("is deterministic", async () => {
    const bundle = await sampleLike();
    expect(scoreBundle(bundle)).toEqual(scoreBundle(bundle));
  });

  it("renormalizes weights when verifiedAIDepth is inapplicable", async () => {
    const r = scoreBundle(await makeBundle({
      anchored: true,
      independentVerifier: true,
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts", "b.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }, { path: "b.ts", size: 500 }] })],
      claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["a", "b"] }],
    }));
    // coverage≈1, claimVerify≈0.9, richness>0, depth=null -> weightedQuality high -> strong score
    expect(r.subScores.weightedQuality).toBeGreaterThan(0.85);
    expect(r.vibeScore).toBeGreaterThanOrEqual(85);
  });
});
