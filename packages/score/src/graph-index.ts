import type {
  ArtifactEdgeType,
  ArtifactGraphEdge,
  ArtifactGraphNode,
  ArtifactNodeType,
  PublicLedgerBundle,
} from "@vibetrace/schema";

export interface GraphIndex {
  nodeById: Map<string, ArtifactGraphNode>;
  nodesByType: Map<ArtifactNodeType, ArtifactGraphNode[]>;
  edgesByType: Map<ArtifactEdgeType, ArtifactGraphEdge[]>;
}

export function indexGraph(bundle: PublicLedgerBundle): GraphIndex {
  const nodeById = new Map<string, ArtifactGraphNode>();
  const nodesByType = new Map<ArtifactNodeType, ArtifactGraphNode[]>();
  const edgesByType = new Map<ArtifactEdgeType, ArtifactGraphEdge[]>();

  for (const node of bundle.publicGraph.nodes) {
    nodeById.set(node.id, node);
    const list = nodesByType.get(node.type) ?? [];
    list.push(node);
    nodesByType.set(node.type, list);
  }

  for (const edge of bundle.publicGraph.edges) {
    const list = edgesByType.get(edge.type) ?? [];
    list.push(edge);
    edgesByType.set(edge.type, list);
  }

  return { nodeById, nodesByType, edgesByType };
}

export function nodesOfType(index: GraphIndex, type: ArtifactNodeType): ArtifactGraphNode[] {
  return index.nodesByType.get(type) ?? [];
}

export function edgesOfType(index: GraphIndex, type: ArtifactEdgeType): ArtifactGraphEdge[] {
  return index.edgesByType.get(type) ?? [];
}
