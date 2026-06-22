import { describe, expect, it } from "vitest";
import { DEFAULT_CONSTANTS, mergeConstants, tierForScore } from "./types";

describe("tierForScore", () => {
  it("maps band boundaries", () => {
    expect(tierForScore(100).tier).toBe("S");
    expect(tierForScore(90).tier).toBe("S");
    expect(tierForScore(89).tier).toBe("A");
    expect(tierForScore(75).tier).toBe("A");
    expect(tierForScore(74).tier).toBe("B");
    expect(tierForScore(55).tier).toBe("B");
    expect(tierForScore(54).tier).toBe("C");
    expect(tierForScore(30).tier).toBe("C");
    expect(tierForScore(29).tier).toBe("D");
    expect(tierForScore(0).tier).toBe("D");
  });

  it("labels the tier", () => {
    expect(tierForScore(80).label).toBe("Provably Vibecoded");
    expect(tierForScore(10).label).toBe("Unanchored / Unproven");
    expect(tierForScore(95).label).toBe("Fully Traced & Anchored");
    expect(tierForScore(60).label).toBe("AI-Assisted, Verified");
    expect(tierForScore(40).label).toBe("AI-Assisted, Unverified");
  });
});

describe("mergeConstants", () => {
  it("returns defaults when no override", () => {
    expect(mergeConstants()).toEqual(DEFAULT_CONSTANTS);
  });

  it("deep-merges nested groups without dropping siblings", () => {
    const c = mergeConstants({ anchor: { unanchoredCeiling: 0.5 } as never });
    expect(c.anchor.unanchoredCeiling).toBe(0.5);
    expect(c.anchor.full).toBe(1.0);
    expect(c.weights.coverage).toBe(0.45);
  });

  it("applies a top-level scalar override while keeping other defaults", () => {
    const c = mergeConstants({ redactionCapValue: 0.99 });
    expect(c.redactionCapValue).toBe(0.99);
    expect(c.weights.coverage).toBe(0.45);
  });

  it("returns a fresh copy that does not alias DEFAULT_CONSTANTS", () => {
    const c = mergeConstants();
    c.anchor.unanchoredCeiling = 0.5;
    c.probeClaimIds.push("mutated");
    expect(DEFAULT_CONSTANTS.anchor.unanchoredCeiling).toBe(0.33);
    expect(DEFAULT_CONSTANTS.probeClaimIds).toEqual(["claim-0g-storage", "claim-0g-compute", "claim-tee-attested"]);
  });
});
