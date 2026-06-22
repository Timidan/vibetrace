import type { ArtifactGraph, ClaimVerdict, EvidenceBadge } from "@vibetrace/schema";

// Structural confidence for a claim that has at least one real file `supports`
// edge. Matches the historical `buildEvidenceBadges` value (0.9) so VibeScore
// behaviour for purely-structural runs is unchanged.
export const STRUCTURAL_CONFIDENCE = 0.9;

export type MergeArgs = {
  claimId: string;
  /** File-only (`file:`-prefixed) node ids with a real `supports` edge to this claim. */
  structuralSupport: string[];
  /** TEE adjudication for this claim. Absent => structural-only degradation. */
  verdict?: ClaimVerdict;
};

// PINNED MERGE TABLE — deterministic, computed locally AFTER the verdict returns.
// The structural check is the one-directional GATE: no support edge => the LLM
// can never promote the claim above `unsupported`.
function mergeStatus(
  hasSupport: boolean,
  verdict: ClaimVerdict | undefined
): EvidenceBadge["status"] {
  if (!hasSupport) return "unsupported"; // gate: LLM cannot promote a baseless claim
  if (!verdict) return "verified"; // structural-only floor (today's behaviour)
  switch (verdict.verdict) {
    case "substantiated":
      return "verified"; // structure + judgment agree
    case "inflated":
      return "partial"; // linked but oversold
    case "unsupported":
      return "partial"; // linked but judgment can't back it — flagged, not silently verified
    default:
      return "partial";
  }
}

function explain(status: EvidenceBadge["status"], supportCount: number, verdict?: ClaimVerdict): string {
  if (status === "unsupported") {
    return "No public artifact in the ledger currently supports this claim.";
  }
  const artifacts = `${supportCount} public artifact${supportCount === 1 ? "" : "s"}`;
  if (status === "verified" && !verdict) {
    return `${artifacts} support this claim.`;
  }
  if (status === "verified") {
    return `${artifacts} support this claim; the attested examiner judged it substantiated.`;
  }
  // partial
  const word = verdict?.verdict === "inflated" ? "inflated (oversold)" : "unsupported by the examiner";
  return `${artifacts} link to this claim, but the attested examiner flagged it as ${word}.`;
}

export function mergeEvidenceBadge(args: MergeArgs): EvidenceBadge {
  const supportingNodes = [...args.structuralSupport].sort();
  const hasSupport = supportingNodes.length > 0;
  const status = mergeStatus(hasSupport, args.verdict);

  // Invariant 2: never more confident than the weakest leg. Unsupported badges
  // carry no confidence.
  const modelConfidence = args.verdict?.confidence ?? STRUCTURAL_CONFIDENCE;
  const confidence = status === "unsupported" ? 0 : Math.min(STRUCTURAL_CONFIDENCE, modelConfidence);

  const badge: EvidenceBadge = {
    claimId: args.claimId,
    status,
    confidence,
    // Invariant 4: badge.supportingNodes stays FILE-ONLY. The verdict's trace: ids
    // (verdict.supportingNodes) are display/audit-only and are NEVER read here.
    supportingNodes,
    publicExplanation: explain(status, supportingNodes.length, args.verdict),
    provenance: args.verdict ? "structural+attested" : "structural-only"
  };

  if (args.verdict) {
    badge.verdict = args.verdict.verdict;
  }

  return badge;
}

// Derive the FILE-ONLY structural support set for `claimId`, identically to
// `hasAnchoredSupport` in score/src/claim-verify.ts:7 — only `file:`-prefixed
// `from` nodes that exist in the graph and have a real `supports` edge to the
// claim. Span/trace ids are deliberately excluded so the merged badge's
// supportingNodes never trips the scoring downgrade.
export function structuralSupportFor(graph: ArtifactGraph, claimId: string): string[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  return graph.edges
    .filter(
      (e) =>
        e.type === "supports" &&
        e.to === claimId &&
        e.from.startsWith("file:") &&
        nodeIds.has(e.from)
    )
    .map((e) => e.from);
}

/**
 * HONESTY GATE (parity with the merge table's one-directional gate): downgrade any positive verdict
 * (substantiated/inflated) for a claim with NO file-only `supports` edge in `graph` to "unsupported"
 * (confidence 0, abstainReason set). The relayer-asserted verdict word feeds the viewer/registry
 * HEADLINE, so a no-support "substantiated" must not survive in run.verdicts even though its badge is
 * already gated. Applied BOTH producer-side (runAttestedAdjudicator) AND client-side
 * (runRelayerAdjudication) so a hostile/buggy relayer cannot land a no-support positive verdict word.
 */
export function downgradeUnsupportedVerdicts(graph: ArtifactGraph, verdicts: ClaimVerdict[]): ClaimVerdict[] {
  return verdicts.map((v) => {
    if (v.verdict !== "unsupported" && structuralSupportFor(graph, v.claimId).length === 0) {
      return { ...v, verdict: "unsupported" as const, confidence: 0, abstainReason: "insufficient-public-evidence" as const };
    }
    return v;
  });
}

export function buildMergedEvidenceBadges(
  graph: ArtifactGraph,
  verdicts?: ClaimVerdict[]
): EvidenceBadge[] {
  const verdictByClaim = new Map<string, ClaimVerdict>();
  for (const v of verdicts ?? []) verdictByClaim.set(v.claimId, v);

  return graph.nodes
    .filter((node) => node.type === "Claim")
    .map((claim) =>
      mergeEvidenceBadge({
        claimId: claim.id,
        structuralSupport: structuralSupportFor(graph, claim.id),
        verdict: verdictByClaim.get(claim.id)
      })
    );
}
