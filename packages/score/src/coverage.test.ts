import { describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage";
import { indexGraph } from "./graph-index";
import { DEFAULT_CONSTANTS } from "./types";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

async function coverageOf(opts: Parameters<typeof makeBundle>[0]) {
  const bundle = await makeBundle(opts);
  const flags: string[] = [];
  return { value: computeCoverage(indexGraph(bundle), DEFAULT_CONSTANTS, flags), flags };
}

describe("computeCoverage", () => {
  it("is 1.0 when every file is AI-produced (equal sizes)", async () => {
    const { value } = await coverageOf({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts", "b.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }, { path: "b.ts", size: 500 }] })],
    });
    expect(value).toBeCloseTo(1.0, 5);
  });

  it("is low when only one of many files is AI-produced", async () => {
    const { value } = await coverageOf({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["f0.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, size: 500 })) })],
    });
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.2);
  });

  it("does NOT count filesMentioned (only produced)", async () => {
    const { value } = await coverageOf({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: [], filesMentioned: ["a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 500 }] })],
    });
    expect(value).toBe(0);
  });

  it("tiny-file padding barely moves coverage (size normalization)", async () => {
    const { value } = await coverageOf({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "a.ts", size: 5000 }, ...Array.from({ length: 5 }, (_, i) => ({ path: `pad${i}`, size: 1 }))] })],
    });
    expect(value).toBeGreaterThan(0.5);
  });

  it("rejects backfilled spans (endedAt after the commit) and flags them", async () => {
    const { value, flags } = await coverageOf({
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["a.ts"], endedAt: "2026-06-18T00:00:00.000Z" })],
      snapshots: [snapshot({ commit: "c1", createdAt: "2026-06-17T10:00:00.000Z", files: [{ path: "a.ts", size: 500 }] })],
    });
    expect(value).toBe(0);
    expect(flags.some((f) => f.startsWith("backfilled-spans:"))).toBe(true);
  });
});
