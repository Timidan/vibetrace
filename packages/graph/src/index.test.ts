import { describe, expect, it } from "vitest";
import { buildArtifactGraph } from "./index";

describe("artifact lineage graph", () => {
  it("links trace spans to artifacts, files, and commit snapshots", () => {
    const graph = buildArtifactGraph({
      snapshots: [
        {
          snapshotId: "snap-1",
          commit: "abc123",
          branch: "main",
          createdAt: "2026-06-17T10:00:00.000Z",
          files: [
            {
              path: "src/storage.ts",
              hash: "0x" + "1".repeat(64),
              size: 120
            }
          ],
          packageMetadata: { name: "demo" }
        }
      ],
      traces: [
        {
          spanId: "span-1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T09:00:00.000Z",
          endedAt: "2026-06-17T09:05:00.000Z",
          promptHash: "0x" + "2".repeat(64),
          responseHash: "0x" + "3".repeat(64),
          filesMentioned: ["src/storage.ts"],
          artifactsProduced: ["src/storage.ts"],
          metadata: {}
        }
      ],
      claims: [
        {
          claimId: "claim-storage",
          text: "Uses 0G Storage",
          selectors: ["storage"]
        }
      ]
    });

    expect(graph.canonicalHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["TraceSpan", "PatchArtifact", "FileVersion", "CommitSnapshot", "Claim"])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "trace:span-1", to: "artifact:src/storage.ts", type: "produced" }),
        expect.objectContaining({ from: "file:src/storage.ts@abc123", to: "commit:abc123", type: "included_in" }),
        expect.objectContaining({ from: "file:src/storage.ts@abc123", to: "claim:claim-storage", type: "supports" })
      ])
    );
  });
});

describe("supports-edge generation is gated by evidence kind", () => {
  // evidence:"external" claims get NO structural supports edge even if the path matches
  it("emits no supports edge for an external-evidence claim", () => {
    const graph = buildArtifactGraph({
      snapshots: [{ commit: "c1", createdAt: "2026-01-01T00:00:00.000Z", files: [{ path: "src/0g/storage.ts", hash: "0xaa", size: 1 }], packageMetadata: {} } as any],
      traces: [],
      claims: [{ claimId: "claim-0g-storage", text: "Uses 0G Storage", selectors: ["0g", "storage"], evidence: "external" }],
    });
    const supports = graph.edges.filter((e) => e.type === "supports" && e.to === "claim:claim-0g-storage");
    expect(supports).toEqual([]);
  });

  // evidence:"trace" claim is supported ONLY by trace-backed files, never path-only matches
  it("emits a supports edge for a trace-evidence claim only when a span produced/mentioned the file", () => {
    const base = {
      snapshots: [{ commit: "c1", createdAt: "2026-01-01T00:00:00.000Z", files: [
        { path: "src/made-by-ai.ts", hash: "0xaa", size: 1 },
        { path: "src/hand-typed.ts", hash: "0xbb", size: 1 },
      ], packageMetadata: {} } as any],
      claims: [{ claimId: "claim-ai-build", text: "Includes AI-assisted build trace evidence", selectors: ["src"], evidence: "trace" as const }],
    };
    // no traces => no support (the exact honesty hole)
    const noTrace = buildArtifactGraph({ ...base, traces: [] });
    expect(noTrace.edges.filter((e) => e.type === "supports" && e.to === "claim:claim-ai-build")).toEqual([]);
    // a span that produced src/made-by-ai.ts => support edge ONLY for that file
    const withTrace = buildArtifactGraph({ ...base, traces: [{
      spanId: "s1", tool: "codex", model: "gpt-5", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z",
      promptHash: "0x" + "a".repeat(64), responseHash: "0x" + "b".repeat(64),
      filesMentioned: [], artifactsProduced: ["src/made-by-ai.ts"], metadata: {},
    } as any] });
    const ids = withTrace.edges.filter((e) => e.type === "supports" && e.to === "claim:claim-ai-build").map((e) => e.from);
    expect(ids).toEqual(["file:src/made-by-ai.ts@c1"]);
  });

  // evidence absent => legacy structural (selector) behavior preserved
  it("preserves legacy selector support when evidence is absent", () => {
    const graph = buildArtifactGraph({
      snapshots: [{ commit: "c1", createdAt: "2026-01-01T00:00:00.000Z", files: [{ path: "src/a.ts", hash: "0xaa", size: 1 }], packageMetadata: {} } as any],
      traces: [],
      claims: [{ claimId: "legacy", text: "legacy", selectors: ["src"] }],
    });
    expect(graph.edges.filter((e) => e.type === "supports" && e.to === "claim:legacy").map((e) => e.from)).toEqual(["file:src/a.ts@c1"]);
  });
});
