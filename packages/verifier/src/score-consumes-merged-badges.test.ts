import { describe, expect, it } from "vitest";
import type { ArtifactGraph, ClaimVerdict, PublicLedgerBundle } from "@vibetrace/schema";
import { DEFAULT_CONSTANTS } from "@vibetrace/score";
import { indexGraph } from "../../score/src/graph-index";
import { computeClaimVerify } from "../../score/src/claim-verify";
import { buildMergedEvidenceBadges } from "./merge";

// One claim with a real file supports edge; one claim with no support.
const graph: ArtifactGraph = {
  nodes: [
    { id: "claim:oauth", type: "Claim", label: "Added OAuth", data: {} },
    { id: "claim:rewrite", type: "Claim", label: "Rewrote payments", data: {} },
    { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: {} }
  ],
  edges: [{ id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" }],
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "0".repeat(64)
};

function bundleWith(badges: PublicLedgerBundle["evidenceBadges"]): PublicLedgerBundle {
  // Minimal bundle: computeClaimVerify only reads evidenceBadges; indexGraph reads publicGraph.
  return { publicGraph: graph, evidenceBadges: badges } as unknown as PublicLedgerBundle;
}

function v(claimId: string, verdict: ClaimVerdict["verdict"], confidence: number): ClaimVerdict {
  return {
    claimId,
    verdict,
    confidence,
    supportingNodes: ["file:auth/oauth.ts@abc"],
    rationale: "r",
    abstainReason: null,
    dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
  };
}

describe("VibeScore consumes merged badges unchanged", () => {
  it("a substantiated+supported merged badge scores like a hasAnchoredSupport verified badge", () => {
    const badges = buildMergedEvidenceBadges(graph, [
      v("claim:oauth", "substantiated", 0.9),
      v("claim:rewrite", "substantiated", 0.9) // promoted? NO — no file edge -> unsupported
    ]);
    const index = indexGraph(bundleWith(badges));
    const flags: string[] = [];
    const score = computeClaimVerify(bundleWith(badges), index, true, DEFAULT_CONSTANTS, flags);

    // oauth: verified, hasAnchoredSupport=true -> +1*0.9 ; rewrite: unsupported -> -0.5.
    // denom = 2 (no private). numerator = 0.9 - 0.5 = 0.4 -> 0.4/2 = 0.2.
    expect(score).toBeCloseTo(0.2, 10);
  });

  it("an inflated verdict downgrades the same claim to partial and lowers the score (no scoring change)", () => {
    const badges = buildMergedEvidenceBadges(graph, [
      v("claim:oauth", "inflated", 0.9),
      v("claim:rewrite", "substantiated", 0.9)
    ]);
    const index = indexGraph(bundleWith(badges));
    const score = computeClaimVerify(bundleWith(badges), index, true, DEFAULT_CONSTANTS, []);

    // oauth: partial -> +0.5*0.9 = 0.45 ; rewrite: unsupported -> -0.5.
    // numerator = -0.05 -> clamped max(0, -0.05/2) = 0.
    expect(score).toBe(0);
  });

  it("the merged badge's file-only supportingNodes survive hasAnchoredSupport (1.0 weight, not the 0.5 downgrade)", () => {
    // If the merge had leaked a span id into supportingNodes, hasAnchoredSupport
    // would fail and verified would score 0.5 instead of 1.0 for oauth.
    const supportedOnly: ArtifactGraph = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== "claim:rewrite")
    };
    const badges = buildMergedEvidenceBadges(supportedOnly, [v("claim:oauth", "substantiated", 0.9)]);
    const index = indexGraph(bundleWith(badges));
    const score = computeClaimVerify(bundleWith(badges), index, true, DEFAULT_CONSTANTS, []);

    // single claim verified + anchored: numerator = 1*0.9 = 0.9, denom = 1 -> min(1, 0.9) = 0.9.
    expect(score).toBeCloseTo(0.9, 10);
  });
});
