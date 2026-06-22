import { describe, expect, it } from "vitest";
import { computeTraceRichness, computeVerifiedAIDepth } from "./trace-quality";
import { indexGraph } from "./graph-index";
import { DEFAULT_CONSTANTS } from "./types";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

describe("computeVerifiedAIDepth", () => {
  it("is null when there are no verified_by edges", async () => {
    const bundle = await makeBundle({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 1 }] })],
    });
    expect(computeVerifiedAIDepth(indexGraph(bundle))).toBeNull();
  });
});

describe("computeTraceRichness", () => {
  it("rewards 1->2 tool pairs more than 8->9 (saturating)", async () => {
    // Spans must produce artifacts to count toward richness (conversation-only
    // spans are excluded), so give each one a produced file.
    const one = await makeBundle({ traces: [traceSpan({ spanId: "s1", tool: "codex", model: "gpt-5", artifactsProduced: ["a.ts"] })], snapshots: [] });
    const two = await makeBundle({
      traces: [
        traceSpan({ spanId: "s1", tool: "codex", model: "gpt-5", artifactsProduced: ["a.ts"] }),
        traceSpan({ spanId: "s2", tool: "claude", model: "sonnet", artifactsProduced: ["b.ts"] }),
      ],
      snapshots: [],
    });
    const r1 = computeTraceRichness(indexGraph(one), DEFAULT_CONSTANTS);
    const r2 = computeTraceRichness(indexGraph(two), DEFAULT_CONSTANTS);
    expect(r2).toBeGreaterThan(r1);
    expect(r1).toBeGreaterThan(0);
    expect(r2).toBeLessThan(1);
  });

  it("is 0 with no trace spans", async () => {
    const bundle = await makeBundle({ traces: [], snapshots: [snapshot({ commit: "c1", files: [{ path: "a", size: 1 }] })] });
    expect(computeTraceRichness(indexGraph(bundle), DEFAULT_CONSTANTS)).toBe(0);
  });
});
