import { describe, expect, it } from "vitest";
import type { EvidenceBadge } from "@vibetrace/schema";
import { computeClaimVerify } from "./claim-verify";
import { indexGraph } from "./graph-index";
import { DEFAULT_CONSTANTS } from "./types";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

const baseArgs = {
  traces: [traceSpan({ spanId: "s1", artifactsProduced: ["src/a.ts"] })],
  snapshots: [snapshot({ commit: "c1", files: [{ path: "src/a.ts", size: 500 }] })],
};

// Synthetic claim (NOT a shipped product id) used to create the `supports`
// file→claim edge the badges must cite. Renamed from the shipped "claim-ai-build"
// so the structural-evidence default does not mask the honesty change (the badge
// id stays "claim:claim-synthetic-a"). It matches src/a.ts so the anchored-support
// check has a real edge.
const defaultClaims = [{ claimId: "claim-synthetic-a", text: "AI build", selectors: ["src/a.ts"] }];

async function claimVerifyOf(badges: EvidenceBadge[], penalizeProbes = false, claims = defaultClaims) {
  const bundle = await makeBundle({ ...baseArgs, claims, anchored: true, evidenceBadgesOverride: badges });
  const flags: string[] = [];
  return { value: computeClaimVerify(bundle, indexGraph(bundle), penalizeProbes, DEFAULT_CONSTANTS, flags), flags };
}

const support = ["file:src/a.ts@c1"];

describe("computeClaimVerify", () => {
  it("one anchored verified claim ⇒ its confidence", async () => {
    const { value } = await claimVerifyOf([
      { claimId: "claim:claim-synthetic-a", status: "verified", confidence: 0.9, supportingNodes: support, publicExplanation: "" },
    ]);
    expect(value).toBeCloseTo(0.9);
  });

  it("0g probe claims are excluded by default (don't tank the score)", async () => {
    const { value } = await claimVerifyOf([
      { claimId: "claim:claim-synthetic-a", status: "verified", confidence: 0.9, supportingNodes: support, publicExplanation: "" },
      { claimId: "claim:claim-0g-storage", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
      { claimId: "claim:claim-0g-compute", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
    ]);
    expect(value).toBeCloseTo(0.9);
  });

  it("all three 0G/TEE probe claims unsupported-offline do NOT penalize, but a non-probe unsupported claim does", async () => {
    // The honest-offline shape: 0G storage/compute + TEE-attested all unsupported.
    // Because all three are probe claims (default penalizeProbeClaims=false), the
    // claim-verify score is driven ONLY by the real synthetic claim => 0.9.
    expect(DEFAULT_CONSTANTS.probeClaimIds).toEqual(
      expect.arrayContaining(["claim-0g-storage", "claim-0g-compute", "claim-tee-attested"]),
    );
    const probesUnsupported = await claimVerifyOf([
      { claimId: "claim:claim-synthetic-a", status: "verified", confidence: 0.9, supportingNodes: support, publicExplanation: "" },
      { claimId: "claim:claim-0g-storage", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
      { claimId: "claim:claim-0g-compute", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
      { claimId: "claim:claim-tee-attested", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
    ]);
    expect(probesUnsupported.value).toBeCloseTo(0.9);

    // CONTRAST: a NON-probe unsupported claim DOES penalize. Same shape but with
    // a synthetic (non-probe) unsupported claim => (0.9 - 0.5) / 2 = 0.2.
    const nonProbeUnsupported = await claimVerifyOf([
      { claimId: "claim:claim-synthetic-a", status: "verified", confidence: 0.9, supportingNodes: support, publicExplanation: "" },
      { claimId: "claim:claim-synthetic-b", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
    ]);
    expect(nonProbeUnsupported.value).toBeCloseTo(0.2);
  });

  it("penalizeProbeClaims=true makes the same probes subtract", async () => {
    const { value } = await claimVerifyOf(
      [
        { claimId: "claim:claim-synthetic-a", status: "verified", confidence: 0.9, supportingNodes: support, publicExplanation: "" },
        { claimId: "claim:claim-0g-storage", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
        { claimId: "claim:claim-0g-compute", status: "unsupported", confidence: 0, supportingNodes: [], publicExplanation: "" },
      ],
      true,
    );
    // (0.9 - 0.5 - 0.5) / 3 -> clamped to 0
    expect(value).toBe(0);
  });

  it("caps at redactionCapValue when >40% of asserted claims are private", async () => {
    const { value, flags } = await claimVerifyOf(
      [
        { claimId: "claim:c-a", status: "verified", confidence: 1, supportingNodes: support, publicExplanation: "" },
        { claimId: "claim:c-b", status: "private", confidence: 0, supportingNodes: [], publicExplanation: "" },
      ],
      false,
      [{ claimId: "c-a", text: "A", selectors: ["src/a.ts"] }],
    );
    expect(value).toBeCloseTo(0.6);
    expect(flags).toContain("redaction-cap");
  });
});
