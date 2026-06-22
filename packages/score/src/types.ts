export type Tier = "S" | "A" | "B" | "C" | "D";

export interface IntegrityResult {
  value: number; // 0..1 (Anchor × VerifierTrust)
  anchored: boolean;
  verified: boolean;
  seal: "anchored-verified" | "anchored" | "self-published" | "broken";
}

export interface SubScores {
  coverage: number;
  claimVerify: number;
  verifiedAIDepth: number | null; // null = inapplicable (renormalized away)
  traceRichness: number;
  weightedQuality: number;
}

/**
 * Proof status — the TRUST dimension, decomposed OUT of the build score (v2).
 * Describes how independently provable the bundle is (anchor + verifier) as a
 * non-numeric label + a rank for leaderboard tie-breaks. It deliberately does NOT
 * feed buildScore: a repo's build quality must not change based on who notarized it.
 */
export interface ProofStatus {
  label: string;
  rank: number; // higher = stronger proof (0 = broken)
  anchor: "onchain" | "dev" | "none" | "mismatch";
  verifier: "independent" | "self" | "none";
  broken: boolean;
}

export interface VibeScoreResult {
  /** Schema version of this result. v2 = Build/Proof decomposition. */
  scoreVersion: 2;
  /** PRIMARY (v2): intrinsic build quality, 0..100 = round(100 × weightedQuality).
   *  Independent of anchor/verifier — re-derivable from the bundle anywhere. */
  buildScore: number;
  buildTier: Tier;
  buildTierLabel: string;
  /** The TRUST dimension, separated out. */
  proof: ProofStatus;
  /** Legacy composite = round(100 × integrity × quality). Kept as a secondary
   *  "trust-weighted roll-up"; equals `vibeScore` for backward-compat. */
  trustWeightedScore: number;

  /** @deprecated v1 alias — the trust-weighted composite. Prefer buildScore + proof. */
  vibeScore: number;
  /** @deprecated v1 alias — tier of the composite. Prefer buildTier. */
  tier: Tier;
  /** @deprecated v1 alias. */
  tierLabel: string;
  integrity: IntegrityResult;
  subScores: SubScores;
  flags: string[];
  /** @deprecated v1 badge built from the trust-weighted composite (tier/score/seal).
   *  Nothing renders from this anymore — the registry/leaderboard badge is built
   *  from buildScore + buildTier + proof (see apps/viewer badgeForEntry). Kept only
   *  so legacy consumers don't break; prefer buildScore/buildTier/proof. */
  badge: { tier: string; label: string; score: number; seal: string };
}

export interface ScoreConstants {
  weights: { coverage: number; claimVerify: number; verifiedAIDepth: number; traceRichness: number };
  anchor: { full: number; unanchoredCeiling: number; broken: number };
  verifierTrust: { independent: number; selfVerified: number; absent: number };
  coverageSizePercentileCap: number;
  redactionCapThreshold: number;
  redactionCapValue: number;
  richnessK: { toolModel: number; spans: number };
  probeClaimIds: string[];
}

export interface ScoreOptions {
  verifierIndependence?: "model-differs" | "0g-compute-only";
  penalizeProbeClaims?: boolean;
  constants?: Partial<ScoreConstants>;
}

export const DEFAULT_CONSTANTS: ScoreConstants = {
  weights: { coverage: 0.45, claimVerify: 0.25, verifiedAIDepth: 0.2, traceRichness: 0.1 },
  anchor: { full: 1.0, unanchoredCeiling: 0.33, broken: 0.0 },
  verifierTrust: { independent: 1.0, selfVerified: 0.7, absent: 0.5 },
  coverageSizePercentileCap: 0.9,
  redactionCapThreshold: 0.4,
  redactionCapValue: 0.6,
  richnessK: { toolModel: 2, spans: 3 },
  probeClaimIds: ["claim-0g-storage", "claim-0g-compute", "claim-tee-attested"],
};

const TIERS: { tier: Tier; min: number; label: string }[] = [
  { tier: "S", min: 90, label: "Fully Traced & Anchored" },
  { tier: "A", min: 75, label: "Provably Vibecoded" },
  { tier: "B", min: 55, label: "AI-Assisted, Verified" },
  { tier: "C", min: 30, label: "AI-Assisted, Unverified" },
  { tier: "D", min: 0, label: "Unanchored / Unproven" },
];

export function tierForScore(score: number): { tier: Tier; label: string } {
  const band = TIERS.find((t) => score >= t.min) ?? TIERS[TIERS.length - 1];
  return { tier: band.tier, label: band.label };
}

/** BUILD tiers (v2): labels describe INTRINSIC build quality ONLY — never proof
 *  state. The legacy TIERS labels ("Anchored", "Unproven") mixed the two, which
 *  made the repo's grade depend on the notarization process. */
const BUILD_TIERS: { tier: Tier; min: number; label: string }[] = [
  { tier: "S", min: 90, label: "Fully AI-Traced" },
  { tier: "A", min: 75, label: "Heavily AI-Built" },
  { tier: "B", min: 55, label: "Substantially AI-Built" },
  { tier: "C", min: 30, label: "Partially AI-Built" },
  { tier: "D", min: 0, label: "Lightly AI-Touched" },
];

export function buildTierForScore(score: number): { tier: Tier; label: string } {
  const band = BUILD_TIERS.find((t) => score >= t.min) ?? BUILD_TIERS[BUILD_TIERS.length - 1];
  return { tier: band.tier, label: band.label };
}

export function mergeConstants(override?: Partial<ScoreConstants>): ScoreConstants {
  const o = override ?? {};
  return {
    ...DEFAULT_CONSTANTS,
    ...o,
    weights: { ...DEFAULT_CONSTANTS.weights, ...o.weights },
    anchor: { ...DEFAULT_CONSTANTS.anchor, ...o.anchor },
    verifierTrust: { ...DEFAULT_CONSTANTS.verifierTrust, ...o.verifierTrust },
    richnessK: { ...DEFAULT_CONSTANTS.richnessK, ...o.richnessK },
    probeClaimIds: o.probeClaimIds ? [...o.probeClaimIds] : [...DEFAULT_CONSTANTS.probeClaimIds],
  };
}
