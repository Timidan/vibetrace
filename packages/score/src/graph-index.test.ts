import { describe, expect, it } from "vitest";
import { edgesOfType, indexGraph, nodesOfType } from "./graph-index";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

describe("indexGraph", () => {
  it("indexes nodes by type and edges by type", async () => {
    const bundle = await makeBundle({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["src/a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "src/a.ts", size: 500 }, { path: "src/b.ts", size: 600 }] })],
      claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["src"] }],
    });
    const index = indexGraph(bundle);
    expect(nodesOfType(index, "TraceSpan")).toHaveLength(1);
    expect(nodesOfType(index, "FileVersion")).toHaveLength(2);
    expect(nodesOfType(index, "CommitSnapshot")).toHaveLength(1);
    expect(edgesOfType(index, "produced")).toHaveLength(1);
    expect(index.nodeById.get("trace:s1")?.type).toBe("TraceSpan");
  });
});
