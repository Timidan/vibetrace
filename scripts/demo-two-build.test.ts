import { describe, expect, it } from "vitest";
import { buildDemoSummaries } from "./demo-two-build";

describe("two-build demo (substantiated + inflated)", () => {
  it("produces exactly two attested rows: one substantiated, one inflated", async () => {
    const rows = await buildDemoSummaries();
    expect(rows).toHaveLength(2);

    const substantiated = rows.find((r) => r.attestedVerdict === "substantiated");
    const inflated = rows.find((r) => r.attestedVerdict === "inflated");
    expect(substantiated).toBeDefined();
    expect(inflated).toBeDefined();

    // Both are TEE-attested (so the marquee flags them pre-click) ...
    expect(substantiated!.teeVerified).toBe(true);
    expect(inflated!.teeVerified).toBe(true);
    // ... and the inflated build honestly downgrades its headline.
    expect(inflated!.substantiatedClaims).toBe(0);
    expect(substantiated!.substantiatedClaims).toBeGreaterThanOrEqual(1);
  });
});
