import {
  ArtifactGraph,
  ArtifactGraphEdge,
  ArtifactGraphNode,
  ClaimInput,
  CommitSnapshotData,
  TraceSpan,
  canonicalHash
} from "@vibetrace/schema";

export type BuildArtifactGraphInput = {
  snapshots: CommitSnapshotData[];
  traces: TraceSpan[];
  claims: ClaimInput[];
};

export function buildArtifactGraph(input: BuildArtifactGraphInput): ArtifactGraph {
  const nodes = new Map<string, ArtifactGraphNode>();
  const edges = new Map<string, ArtifactGraphEdge>();

  for (const trace of sortBy(input.traces, (trace) => trace.spanId)) {
    addNode(nodes, {
      id: traceNodeId(trace.spanId),
      type: "TraceSpan",
      label: `${trace.tool} / ${trace.model}`,
      data: {
        spanId: trace.spanId,
        tool: trace.tool,
        model: trace.model,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        promptHash: trace.promptHash,
        responseHash: trace.responseHash,
        filesMentioned: trace.filesMentioned,
        artifactsProduced: trace.artifactsProduced,
        metadata: redactTraceMetadata(trace.metadata)
      }
    });

    for (const artifactPath of trace.artifactsProduced.sort()) {
      const artifactId = artifactNodeId(artifactPath);
      addNode(nodes, {
        id: artifactId,
        type: "PatchArtifact",
        label: artifactPath,
        data: { path: artifactPath }
      });
      addEdge(edges, traceNodeId(trace.spanId), artifactId, "produced");
    }
  }

  for (const snapshot of sortBy(input.snapshots, (snapshot) => `${snapshot.createdAt}:${snapshot.commit}`)) {
    const commitId = commitNodeId(snapshot.commit);
    addNode(nodes, {
      id: commitId,
      type: "CommitSnapshot",
      label: snapshot.commit,
      data: redactSnapshot(snapshot)
    });

    for (const file of sortBy(snapshot.files, (file) => file.path)) {
      const fileId = fileNodeId(file.path, snapshot.commit);
      addNode(nodes, {
        id: fileId,
        type: "FileVersion",
        label: file.path,
        data: {
          path: file.path,
          hash: file.hash,
          size: file.size,
          commit: snapshot.commit
        }
      });
      addEdge(edges, fileId, commitId, "included_in");

      for (const trace of input.traces) {
        if (trace.artifactsProduced.includes(file.path) || trace.filesMentioned.includes(file.path)) {
          addEdge(edges, artifactNodeId(file.path), fileId, "modified");
        }
      }
    }
  }

  for (const claim of sortBy(input.claims, (claim) => claim.claimId)) {
    const claimId = claimNodeId(claim.claimId);
    addNode(nodes, {
      id: claimId,
      type: "Claim",
      label: claim.text,
      data: claim
    });

    const evidence = claim.evidence ?? "structural";
    if (evidence === "external") continue; // upgraded only by real publish-time evidence; never structural

    for (const snapshot of input.snapshots) {
      for (const file of snapshot.files) {
        if (!selectorsMatchFile(claim.selectors, file.path)) continue;
        if (evidence === "trace" && !fileIsTraceBacked(input.traces, file.path)) continue; // honesty gate
        addEdge(edges, fileNodeId(file.path, snapshot.commit), claimId, "supports", {
          matchedSelectors: claim.selectors.filter((selector) => file.path.toLowerCase().includes(selector.toLowerCase())),
          traceBacked: evidence === "trace" ? true : undefined
        });
      }
    }
  }

  const graphWithoutHash = {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    redactionPolicy: "private-by-default" as const,
    canonicalHash: "pending"
  };

  return {
    ...graphWithoutHash,
    canonicalHash: canonicalHash(graphWithoutHash)
  };
}

/**
 * The public graph is private-by-default. Drop local-identifying trace metadata
 * (sessionId, agentId, token counts) before it reaches a public node; keep only
 * non-identifying fields like `source`.
 */
const SENSITIVE_TRACE_META = new Set(["sessionId", "agentId", "tokens"]);
function redactTraceMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!SENSITIVE_TRACE_META.has(key)) safe[key] = value;
  }
  return safe;
}

/**
 * Redact a snapshot for the public graph: keep files (needed for coverage) but
 * strip package.json scripts / dependencies / devDependencies — publish only the
 * package name, never the internal scripts or dependency graph.
 */
function redactSnapshot(snapshot: CommitSnapshotData): CommitSnapshotData {
  const pkg = snapshot.packageMetadata;
  const name = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>).name : undefined;
  return { ...snapshot, packageMetadata: name ? { name } : {} };
}

function addNode(nodes: Map<string, ArtifactGraphNode>, node: ArtifactGraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function addEdge(
  edges: Map<string, ArtifactGraphEdge>,
  from: string,
  to: string,
  type: ArtifactGraphEdge["type"],
  data?: Record<string, unknown>
): void {
  const id = `${from}->${type}->${to}`;
  if (!edges.has(id)) {
    edges.set(id, { id, from, to, type, data });
  }
}

function selectorsMatchFile(selectors: string[], filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return selectors.some((selector) => normalized.includes(selector.toLowerCase()));
}

function fileIsTraceBacked(traces: TraceSpan[], filePath: string): boolean {
  return traces.some(
    (t) => t.artifactsProduced.includes(filePath) || t.filesMentioned.includes(filePath)
  );
}

function sortBy<T>(items: T[], selector: (item: T) => string): T[] {
  return [...items].sort((a, b) => selector(a).localeCompare(selector(b)));
}

function traceNodeId(spanId: string): string {
  return `trace:${spanId}`;
}

function artifactNodeId(path: string): string {
  return `artifact:${path}`;
}

function fileNodeId(path: string, commit: string): string {
  return `file:${path}@${commit}`;
}

function commitNodeId(commit: string): string {
  return `commit:${commit}`;
}

function claimNodeId(claimId: string): string {
  return `claim:${claimId}`;
}
