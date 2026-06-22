import { describe, expect, it } from "vitest";
import type { ArtifactGraph, ClaimVerdict } from "@vibetrace/schema";
import { buildMergedEvidenceBadges, mergeEvidenceBadge } from "./merge";

// A fully-populated ClaimVerdict factory so each test only varies what it asserts on.
function verdict(overrides: Partial<ClaimVerdict> & Pick<ClaimVerdict, "verdict">): ClaimVerdict {
  return {
    claimId: "claim:oauth",
    confidence: 0.8,
    supportingNodes: ["trace:s1", "file:auth/oauth.ts@abc"],
    rationale: "cites file:auth/oauth.ts@abc",
    abstainReason: null,
    dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" },
    ...overrides
  };
}

const FILE = "file:auth/oauth.ts@abc";

describe("mergeEvidenceBadge — PINNED MERGE TABLE", () => {
  it("supports edge + substantiated -> verified", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({ verdict: "substantiated", confidence: 0.7 })
    });
    expect(badge.status).toBe("verified");
    expect(badge.provenance).toBe("structural+attested");
    expect(badge.verdict).toBe("substantiated");
  });

  it("supports edge + inflated -> partial (real but oversold)", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({ verdict: "inflated", confidence: 0.6 })
    });
    expect(badge.status).toBe("partial");
    expect(badge.verdict).toBe("inflated");
  });

  it("supports edge + unsupported -> partial (linked but judgment can't back it)", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({ verdict: "unsupported", confidence: 0.2 })
    });
    expect(badge.status).toBe("partial");
    expect(badge.verdict).toBe("unsupported");
  });

  it("NO supports edge + substantiated -> unsupported (one-directional gate: LLM cannot promote)", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [],
      verdict: verdict({ verdict: "substantiated", confidence: 0.99 })
    });
    expect(badge.status).toBe("unsupported");
  });

  it("NO supports edge + inflated -> unsupported", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [],
      verdict: verdict({ verdict: "inflated", confidence: 0.5 })
    });
    expect(badge.status).toBe("unsupported");
  });

  it("NO supports edge + unsupported -> unsupported", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [],
      verdict: verdict({ verdict: "unsupported", confidence: 0 })
    });
    expect(badge.status).toBe("unsupported");
  });

  it("TEE verdict absent (structural-only degradation) -> structural-only provenance, no verdict word", () => {
    const supported = mergeEvidenceBadge({ claimId: "claim:oauth", structuralSupport: [FILE] });
    expect(supported.status).toBe("verified");
    expect(supported.provenance).toBe("structural-only");
    expect(supported.verdict).toBeUndefined();

    const unsupported = mergeEvidenceBadge({ claimId: "claim:oauth", structuralSupport: [] });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.provenance).toBe("structural-only");
  });
});

describe("mergeEvidenceBadge — invariants", () => {
  it("supportingNodes stays FILE-ONLY (span/trace ids from the verdict are never copied into the badge)", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({
        verdict: "substantiated",
        supportingNodes: ["trace:s1", "file:other.ts@zzz", FILE]
      })
    });
    // Only the structural (file-only) support set drives the badge; the verdict's
    // trace: ids and any file it names that lacks a structural edge are display/audit-only.
    expect(badge.supportingNodes).toEqual([FILE]);
    expect(badge.supportingNodes.every((id) => id.startsWith("file:"))).toBe(true);
  });

  it("confidence = min(structuralConfidence, modelConfidence)", () => {
    // structuralConfidence is 0.9 for a supported claim (matches today's buildEvidenceBadges).
    const modelLower = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({ verdict: "substantiated", confidence: 0.4 })
    });
    expect(modelLower.confidence).toBe(0.4); // min(0.9, 0.4)

    const structuralLower = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [FILE],
      verdict: verdict({ verdict: "substantiated", confidence: 0.95 })
    });
    expect(structuralLower.confidence).toBe(0.9); // min(0.9, 0.95)
  });

  it("confidence is 0 whenever the badge is unsupported, regardless of model confidence", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: [],
      verdict: verdict({ verdict: "substantiated", confidence: 0.99 })
    });
    expect(badge.confidence).toBe(0);
  });

  it("supportingNodes is sorted for deterministic output", () => {
    const badge = mergeEvidenceBadge({
      claimId: "claim:oauth",
      structuralSupport: ["file:b.ts@2", "file:a.ts@1"]
    });
    expect(badge.supportingNodes).toEqual(["file:a.ts@1", "file:b.ts@2"]);
  });
});

describe("buildMergedEvidenceBadges — graph derivation", () => {
  // Graph: claim:oauth supported by a real file edge AND a span edge.
  // claim:rewrite supported only by a span edge (no file -> structural gate fails).
  const graph: ArtifactGraph = {
    nodes: [
      { id: "claim:oauth", type: "Claim", label: "Added OAuth", data: {} },
      { id: "claim:rewrite", type: "Claim", label: "Rewrote payments", data: {} },
      { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: {} },
      { id: "trace:s1", type: "TraceSpan", label: "span", data: {} }
    ],
    edges: [
      { id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" },
      { id: "e2", from: "trace:s1", to: "claim:oauth", type: "supports" },
      { id: "e3", from: "trace:s1", to: "claim:rewrite", type: "supports" }
    ],
    redactionPolicy: "private-by-default",
    canonicalHash: "0x" + "0".repeat(64)
  };

  function verdict(claimId: string, v: ClaimVerdict["verdict"]): ClaimVerdict {
    return {
      claimId,
      verdict: v,
      confidence: 0.8,
      supportingNodes: ["trace:s1", "file:auth/oauth.ts@abc"],
      rationale: "r",
      abstainReason: null,
      dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
    };
  }

  it("derives FILE-ONLY structural support: span supports edges do not count", () => {
    const badges = buildMergedEvidenceBadges(graph, [
      verdict("claim:oauth", "substantiated"),
      verdict("claim:rewrite", "substantiated")
    ]);
    const oauth = badges.find((b) => b.claimId === "claim:oauth")!;
    const rewrite = badges.find((b) => b.claimId === "claim:rewrite")!;

    // oauth has a real FILE supports edge -> gate open -> substantiated -> verified.
    expect(oauth.status).toBe("verified");
    expect(oauth.supportingNodes).toEqual(["file:auth/oauth.ts@abc"]);

    // rewrite is supported only by a span edge -> structural gate CLOSED ->
    // unsupported regardless of the substantiated verdict (the one-directional gate).
    expect(rewrite.status).toBe("unsupported");
    expect(rewrite.supportingNodes).toEqual([]);
  });

  it("emits one badge per Claim node in graph order", () => {
    const badges = buildMergedEvidenceBadges(graph);
    expect(badges.map((b) => b.claimId)).toEqual(["claim:oauth", "claim:rewrite"]);
  });

  it("structural-only when verdicts omitted (degradation path)", () => {
    const badges = buildMergedEvidenceBadges(graph);
    const oauth = badges.find((b) => b.claimId === "claim:oauth")!;
    expect(oauth.status).toBe("verified");
    expect(oauth.provenance).toBe("structural-only");
    expect(oauth.verdict).toBeUndefined();
  });

  it("inflated verdict on a structurally-supported claim downgrades to partial", () => {
    const badges = buildMergedEvidenceBadges(graph, [verdict("claim:oauth", "inflated")]);
    const oauth = badges.find((b) => b.claimId === "claim:oauth")!;
    expect(oauth.status).toBe("partial");
    expect(oauth.verdict).toBe("inflated");
  });
});
