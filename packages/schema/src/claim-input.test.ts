import { describe, it, expect } from "vitest";
import type { ClaimInput } from "./index";

describe("ClaimInput.evidence", () => {
  it("is optional and accepts the three kinds", () => {
    const a: ClaimInput = { claimId: "c", text: "t", selectors: [] };
    const b: ClaimInput = { claimId: "c", text: "t", selectors: [], evidence: "trace" };
    const c: ClaimInput = { claimId: "c", text: "t", selectors: [], evidence: "external" };
    expect([a.evidence, b.evidence, c.evidence]).toEqual([undefined, "trace", "external"]);
  });
});
