import { describe, expect, it } from "vitest";
import type { ArtifactGraph } from "@vibetrace/schema";
import { buildStructuralNeighborhood, buildStructuralSupportSet, orderedClaimSupporters } from "./structural-support";

const graph: ArtifactGraph = {
  nodes: [
    { id: "claim:oauth", type: "Claim", label: "OAuth", data: {} },
    { id: "claim:none", type: "Claim", label: "No support", data: {} },
    { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: {} },
    { id: "trace:s1", type: "TraceSpan", label: "span", data: {} }
  ],
  edges: [
    { id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" },
    { id: "e2", from: "trace:s1", to: "claim:oauth", type: "supports" }
  ],
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "2".repeat(64)
};

describe("buildStructuralNeighborhood", () => {
  it("includes BOTH file- and trace-prefixed supporters per claim (verdict gate)", () => {
    const n = buildStructuralNeighborhood(graph);
    expect([...(n.get("claim:oauth") ?? [])].sort()).toEqual(["file:auth/oauth.ts@abc", "trace:s1"]);
  });

  it("returns an empty set for a claim with no supports edge", () => {
    const n = buildStructuralNeighborhood(graph);
    expect([...(n.get("claim:none") ?? [])]).toEqual([]);
  });
});

describe("orderedClaimSupporters", () => {
  it("orders file- before trace-prefixed supporters, deterministically (the index→id table)", () => {
    const o = orderedClaimSupporters(graph);
    expect(o.get("claim:oauth")).toEqual(["file:auth/oauth.ts@abc", "trace:s1"]);
  });

  it("returns an empty array for a claim with no supports edge", () => {
    const o = orderedClaimSupporters(graph);
    expect(o.get("claim:none")).toEqual([]);
  });

  it("is stable across calls — same input yields identical ordering", () => {
    expect(orderedClaimSupporters(graph).get("claim:oauth")).toEqual(
      orderedClaimSupporters(graph).get("claim:oauth")
    );
  });
});

describe("buildStructuralSupportSet", () => {
  it("collects ONLY file-prefixed supporters per claim (badge gate)", () => {
    const set = buildStructuralSupportSet(graph);
    expect([...(set.get("claim:oauth") ?? [])]).toEqual(["file:auth/oauth.ts@abc"]);
  });

  it("excludes non-file (trace) supporters", () => {
    const set = buildStructuralSupportSet(graph);
    expect(set.get("claim:oauth")?.has("trace:s1")).toBe(false);
  });

  it("returns an empty set for a claim with no supports edge", () => {
    const set = buildStructuralSupportSet(graph);
    expect([...(set.get("claim:none") ?? [])]).toEqual([]);
  });
});
