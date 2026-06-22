import type { ArtifactGraph } from "@vibetrace/schema";

/**
 * For each Claim node, the set of node ids that have a real `supports` edge into it,
 * restricted to the two real public prefixes: "file:" (file versions) and "trace:"
 * (AI trace spans — the real prefix from packages/graph/src/index.ts; there is NO
 * "span:" prefix). This is the VERDICT gate: a ClaimVerdict.supportingNodes MAY cite
 * trace:/file: ids (display/audit only), so it is validated against this broader set.
 */
export function buildStructuralNeighborhood(graph: ArtifactGraph): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.type === "Claim") {
      result.set(node.id, new Set<string>());
    }
  }
  for (const edge of graph.edges) {
    if (edge.type !== "supports") continue;
    if (!edge.from.startsWith("file:") && !edge.from.startsWith("trace:")) continue;
    const bucket = result.get(edge.to);
    if (bucket) {
      bucket.add(edge.from);
    }
  }
  return result;
}

/**
 * Each Claim's structural-neighborhood supporters as a DETERMINISTIC ordered array. The array index
 * is the stable "candidate number" the adjudicator model cites (`supportingNodeIndices`) instead of a
 * raw id — so a weak model can never emit a PHANTOM id (an out-of-range index is simply dropped),
 * which is the failure that trips crossCheckAdjudication on large graphs. The request builder and the
 * response mapper BOTH call this, so the index→id mapping is identical on both ends. Order is stable:
 * file: nodes before trace: nodes, then lexicographic id — no randomness, no time.
 */
export function orderedClaimSupporters(graph: ArtifactGraph): Map<string, string[]> {
  const neighborhood = buildStructuralNeighborhood(graph);
  const ordered = new Map<string, string[]>();
  for (const [claimId, set] of neighborhood) {
    ordered.set(
      claimId,
      [...set].sort((a, b) => {
        const fa = a.startsWith("file:") ? 0 : 1;
        const fb = b.startsWith("file:") ? 0 : 1;
        return fa !== fb ? fa - fb : a.localeCompare(b);
      })
    );
  }
  return ordered;
}

/**
 * The FILE-ONLY subset of the neighborhood: for each Claim node, the "file:"-prefixed
 * supporters only. This is the BADGE gate. It is intentionally NARROWER than the
 * verdict gate above, because score/src/claim-verify.ts:7 hasAnchoredSupport downgrades
 * any badge whose supportingNodes are not file-prefixed with a real supports edge.
 * Keeping badges file-only lets attested verdicts flow into VibeScore unchanged.
 */
export function buildStructuralSupportSet(graph: ArtifactGraph): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.type === "Claim") {
      result.set(node.id, new Set<string>());
    }
  }
  for (const edge of graph.edges) {
    if (edge.type !== "supports") continue;
    if (!edge.from.startsWith("file:")) continue;
    const bucket = result.get(edge.to);
    if (bucket) {
      bucket.add(edge.from);
    }
  }
  return result;
}
