import { describe, expect, it } from "vitest";
import { parseAdjudicationV1, normalizeAdjudicationEnums } from "./adjudication-schema";

const valid = {
  schema: "vibetrace.adjudication.v1",
  graphHash: "0x" + "a".repeat(64),
  evidenceTier: "public-only",
  claims: [
    {
      claimId: "claim:oauth",
      verdict: "substantiated",
      confidence: 0.8,
      supportingNodes: ["file:auth/oauth.ts@abc"],
      rationale: "auth/oauth.ts implements the login flow",
      abstainReason: null,
      dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
    }
  ],
  abstained: []
};

describe("parseAdjudicationV1", () => {
  it("accepts a well-formed adjudication", () => {
    const parsed = parseAdjudicationV1(valid);
    expect(parsed.claims[0].verdict).toBe("substantiated");
    expect(parsed.evidenceTier).toBe("public-only");
  });

  it("rejects a wrong schema tag", () => {
    expect(() => parseAdjudicationV1({ ...valid, schema: "vibetrace.adjudication.v2" })).toThrow();
  });

  it("rejects an unknown verdict value", () => {
    const bad = { ...valid, claims: [{ ...valid.claims[0], verdict: "great" }] };
    expect(() => parseAdjudicationV1(bad)).toThrow();
  });

  it("rejects a rationale longer than 240 chars", () => {
    const bad = { ...valid, claims: [{ ...valid.claims[0], rationale: "x".repeat(241) }] };
    expect(() => parseAdjudicationV1(bad)).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => parseAdjudicationV1({ ...valid, extra: 1 })).toThrow();
  });

  it("defaults OMITTED dimensions to the MOST conservative value (never inflates)", () => {
    const { dimensions: _drop, ...claimNoDims } = valid.claims[0];
    const parsed = parseAdjudicationV1({ ...valid, claims: [claimNoDims] });
    // A weak model that omits dimensions must NOT get a flattering default — the floor is none/absent/none.
    expect(parsed.claims[0].dimensions).toEqual({
      relevance: "none",
      sufficiency: "absent",
      contradiction: "none"
    });
  });
});

describe("normalizeAdjudicationEnums", () => {
  it("maps known weak-model synonyms to the schema vocabulary (the live qwen behavior)", () => {
    const noisy = {
      ...valid,
      claims: [{ ...valid.claims[0], verdict: "supported", dimensions: { relevance: "relevant", sufficiency: "sufficient", contradiction: "absent" } }]
    };
    const parsed = parseAdjudicationV1(normalizeAdjudicationEnums(noisy));
    expect(parsed.claims[0].verdict).toBe("substantiated");
    expect(parsed.claims[0].dimensions).toEqual({ relevance: "strong", sufficiency: "proportionate", contradiction: "none" });
  });

  it("CONSERVATIVELY defaults UNKNOWN enum tokens (never inflates an unrecognized value)", () => {
    const garbage = {
      ...valid,
      claims: [{ ...valid.claims[0], verdict: "totally-made-up", dimensions: { relevance: "??", sufficiency: "??", contradiction: "??" } }]
    };
    const parsed = parseAdjudicationV1(normalizeAdjudicationEnums(garbage));
    expect(parsed.claims[0].verdict).toBe("unsupported");
    expect(parsed.claims[0].dimensions).toEqual({ relevance: "none", sufficiency: "absent", contradiction: "none" });
  });

  it("leaves already-valid values unchanged", () => {
    const parsed = parseAdjudicationV1(normalizeAdjudicationEnums(valid));
    expect(parsed.claims[0].verdict).toBe("substantiated");
    expect(parsed.claims[0].dimensions.relevance).toBe("strong");
  });
});
