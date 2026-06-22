import { type GraphIndex, edgesOfType, nodesOfType } from "./graph-index";
import type { ScoreConstants } from "./types";

const sat = (x: number, k: number) => 1 - Math.exp(-x / k);

export function computeVerifiedAIDepth(index: GraphIndex): number | null {
  const verifiedBy = edgesOfType(index, "verified_by");
  if (verifiedBy.length === 0) return null; // inapplicable in v1

  const spans = nodesOfType(index, "TraceSpan");
  if (spans.length === 0) return null;

  const touched = new Set<string>();
  for (const e of verifiedBy) {
    touched.add(e.from);
    touched.add(e.to);
  }
  const withVerify = spans.filter((s) => touched.has(s.id)).length;
  return withVerify / spans.length;
}

export function computeTraceRichness(index: GraphIndex, c: ScoreConstants): number {
  const allSpans = nodesOfType(index, "TraceSpan");
  if (allSpans.length === 0) return 0;

  // Only spans that actually PRODUCED repo artifacts count toward richness —
  // a conversation-only span (no `produced` edge) is not build provenance and
  // must not inflate the score (technical review finding).
  const producing = new Set(edgesOfType(index, "produced").map((e) => e.from));
  const spans = allSpans.filter((s) => producing.has(s.id));
  if (spans.length === 0) return 0;

  const pairs = new Set(spans.map((s) => `${String(s.data.tool)}/${String(s.data.model)}`)).size;
  return 0.5 * sat(pairs, c.richnessK.toolModel) + 0.5 * sat(spans.length, c.richnessK.spans);
}
