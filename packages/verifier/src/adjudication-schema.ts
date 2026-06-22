import { z } from "zod";

const hexHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "expected a 0x-prefixed 32-byte hex hash");

const claimSchema = z
  .object({
    claimId: z.string().min(1),
    verdict: z.enum(["substantiated", "inflated", "unsupported"]),
    confidence: z.number().min(0).max(1),
    supportingNodes: z.array(z.string().min(1)),
    rationale: z.string().max(240),
    abstainReason: z.literal("insufficient-public-evidence").nullable().default(null),
    // dimensions are SUPPORTING metadata (the verdict itself carries the judgment). Real-world weak
    // TEE models often omit them; default CONSERVATIVELY (never inflates) so a missing-dimensions
    // response still parses. Applied identically on producer + validator, so the verdictRoot binding
    // is unaffected.
    dimensions: z
      .object({
        relevance: z.enum(["strong", "weak", "none"]),
        sufficiency: z.enum(["proportionate", "thin", "absent"]),
        contradiction: z.enum(["none", "present"])
      })
      .strict()
      .default({ relevance: "none", sufficiency: "absent", contradiction: "none" })
  })
  .strict();

export const adjudicationV1Schema = z
  .object({
    schema: z.literal("vibetrace.adjudication.v1"),
    graphHash: hexHash,
    evidenceTier: z.enum(["private", "public-only"]),
    privateEvidenceRoot: hexHash.optional(),
    claims: z.array(claimSchema),
    abstained: z.array(z.string()).default([])
  })
  .strict();

export type AdjudicationV1 = z.infer<typeof adjudicationV1Schema>;

export function parseAdjudicationV1(raw: unknown): AdjudicationV1 {
  return adjudicationV1Schema.parse(raw);
}

/**
 * Recover the adjudication JSON object from possibly-noisy enclave RESPONSE CONTENT. Real-world TEE
 * models wrap the object in code fences or append stray tokens; this strips fences and returns the
 * substring from the first `{` to its matching balanced `}` (string-aware, so braces inside string
 * values don't miscount). Applied PRODUCER-SIDE ONLY, to the completion `content` (runAttestedAdjudicator),
 * to derive the verdicts. The client does NOT run this: validateAttestationLocally verifies the enclave
 * signature over the `responseHash:chatID` EXECUTION material and the verdicts' self-consistency with
 * verdictRoot — it never re-parses JSON from the signed text.
 */
export function extractAdjudicationJson(text: string): string {
  const stripped = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  if (start === -1) return stripped; // no object — let JSON.parse throw a clear error
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return stripped.slice(start); // unbalanced — JSON.parse will throw
}

/**
 * Normalize a parsed adjudication object's ENUM fields to the schema's vocabulary BEFORE Zod parsing.
 * Real-world weak TEE models judge correctly but use synonyms (verdict "supported" for "substantiated",
 * relevance "relevant" for "strong"). This maps known synonyms and CONSERVATIVELY defaults unknowns
 * (verdict→"unsupported", dimensions→none/absent/none) so the run never inflates on an unrecognized
 * token. Applied producer-side before `parseAdjudicationV1`; the resulting verdicts are what get
 * persisted + hashed into verdictRoot, so the client (which parses the persisted verdicts) stays
 * consistent. Honesty is preserved by the one-directional merge gate: a claim with no support edge
 * cannot be promoted regardless of the (normalized) verdict word.
 */
export function normalizeAdjudicationEnums(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.claims)) return raw;
  const VERDICT: Record<string, string> = {
    substantiated: "substantiated", supported: "substantiated", verified: "substantiated", proven: "substantiated", confirmed: "substantiated",
    inflated: "inflated", overstated: "inflated", partial: "inflated", overclaimed: "inflated",
    unsupported: "unsupported", unsubstantiated: "unsupported", unproven: "unsupported", "not supported": "unsupported", none: "unsupported", insufficient: "unsupported"
  };
  const REL: Record<string, string> = { strong: "strong", relevant: "strong", high: "strong", direct: "strong", weak: "weak", partial: "weak", medium: "weak", some: "weak", none: "none", irrelevant: "none", low: "none" };
  const SUF: Record<string, string> = { proportionate: "proportionate", sufficient: "proportionate", strong: "proportionate", adequate: "proportionate", thin: "thin", partial: "thin", weak: "thin", limited: "thin", absent: "absent", insufficient: "absent", none: "absent" };
  const CON: Record<string, string> = { none: "none", absent: "none", no: "none", present: "present", contradicts: "present", conflict: "present", yes: "present" };
  const pick = (m: Record<string, string>, v: unknown, dflt: string): string =>
    (typeof v === "string" && m[v.toLowerCase().trim()]) || dflt;
  return {
    ...obj,
    claims: obj.claims.map((c) => {
      if (!c || typeof c !== "object") return c;
      const cc = c as Record<string, unknown>;
      const d = (cc.dimensions && typeof cc.dimensions === "object" ? cc.dimensions : {}) as Record<string, unknown>;
      return {
        ...cc,
        verdict: pick(VERDICT, cc.verdict, "unsupported"),
        dimensions: {
          relevance: pick(REL, d.relevance, "none"),
          sufficiency: pick(SUF, d.sufficiency, "absent"),
          contradiction: pick(CON, d.contradiction, "none")
        }
      };
    })
  };
}
