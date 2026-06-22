import type { CommitSnapshotData } from "@vibetrace/schema";
import { type GraphIndex, edgesOfType, nodesOfType } from "./graph-index";
import type { ScoreConstants } from "./types";

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function computeCoverage(index: GraphIndex, c: ScoreConstants, flags: string[]): number {
  const fileNodes = nodesOfType(index, "FileVersion");
  if (fileNodes.length === 0) return 0;

  const sizes = fileNodes.map((n) => Number(n.data.size) || 0).sort((a, b) => a - b);
  const cap = percentile(sizes, c.coverageSizePercentileCap);
  const weight = (size: number) => Math.log1p(Math.min(Number(size) || 0, cap || Number.MAX_SAFE_INTEGER));

  const denom = fileNodes.reduce((sum, n) => sum + weight(Number(n.data.size) || 0), 0);
  if (denom === 0) return 0;

  // produced artifacts: artifact ids that have an incoming `produced` edge from a TraceSpan
  const producedArtifactToSpans = new Map<string, string[]>();
  for (const e of edgesOfType(index, "produced")) {
    const list = producedArtifactToSpans.get(e.to) ?? [];
    list.push(e.from);
    producedArtifactToSpans.set(e.to, list);
  }

  const commitCreatedAt = (commit: string): number => {
    const node = index.nodeById.get(`commit:${commit}`);
    const createdAt = node ? (node.data as CommitSnapshotData).createdAt : undefined;
    return createdAt ? Date.parse(createdAt) : Number.POSITIVE_INFINITY;
  };
  const spanEndedAt = (spanId: string): number => {
    const node = index.nodeById.get(spanId);
    const endedAt = node ? String(node.data.endedAt ?? "") : "";
    return endedAt ? Date.parse(endedAt) : Number.POSITIVE_INFINITY;
  };

  const counted = new Set<string>();
  let numerator = 0;
  let backfilled = 0;

  for (const e of edgesOfType(index, "modified")) {
    const producingSpans = producedArtifactToSpans.get(e.from);
    if (!producingSpans) continue; // mentioned-only artifact: not produced ⇒ excluded
    const fileNode = index.nodeById.get(e.to);
    if (!fileNode || fileNode.type !== "FileVersion" || counted.has(fileNode.id)) continue;

    const commitTime = commitCreatedAt(String(fileNode.data.commit));
    const hasValidSpan = producingSpans.some((s) => spanEndedAt(s) <= commitTime);
    if (!hasValidSpan) {
      backfilled += 1;
      continue;
    }

    counted.add(fileNode.id);
    numerator += weight(Number(fileNode.data.size) || 0);
  }

  if (backfilled > 0) flags.push(`backfilled-spans:${backfilled}`);

  return Math.min(1, Math.max(0, numerator / denom));
}
