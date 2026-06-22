import type { PublicLedgerBundle } from "@vibetrace/schema";
import { computeClaimVerify } from "./claim-verify";
import { computeCoverage } from "./coverage";
import { indexGraph } from "./graph-index";
import { computeIntegrity } from "./integrity";
import { computeTraceRichness, computeVerifiedAIDepth } from "./trace-quality";
import {
  buildTierForScore,
  mergeConstants,
  tierForScore,
  type IntegrityResult,
  type ProofStatus,
  type ScoreOptions,
  type SubScores,
  type VibeScoreResult,
} from "./types";

export * from "./types";

export const SCORE_PACKAGE = "@vibetrace/score";

function weightedQuality(sub: Omit<SubScores, "weightedQuality">, w: { coverage: number; claimVerify: number; verifiedAIDepth: number; traceRichness: number }): number {
  const parts: { v: number; w: number }[] = [
    { v: sub.coverage, w: w.coverage },
    { v: sub.claimVerify, w: w.claimVerify },
    { v: sub.traceRichness, w: w.traceRichness },
  ];
  if (sub.verifiedAIDepth !== null) parts.push({ v: sub.verifiedAIDepth, w: w.verifiedAIDepth });

  const totalWeight = parts.reduce((s, p) => s + p.w, 0);
  if (totalWeight === 0) return 0;
  return parts.reduce((s, p) => s + p.v * p.w, 0) / totalWeight;
}

const clampScore = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Derive the non-numeric proof status (anchor + verifier) from integrity + the
 * bundle's chain provider. This is the TRUST axis, kept OUT of buildScore — a
 * repo's build quality must not change based on who notarized it.
 */
function computeProof(bundle: PublicLedgerBundle, integrity: IntegrityResult, flags: string[]): ProofStatus {
  const broken = integrity.seal === "broken";
  const chainProvider = String(bundle.chainAnchor?.provider ?? "").toLowerCase();
  const anchor: ProofStatus["anchor"] = broken
    ? "mismatch"
    : integrity.anchored
      ? "onchain"
      : chainProvider === "0g-dev"
        ? "dev"
        : "none";
  const verifier: ProofStatus["verifier"] = flags.includes("no-verifier")
    ? "none"
    : integrity.verified
      ? "independent"
      : "self";

  const anchorWord =
    anchor === "onchain"
      ? "Anchored on 0G"
      : anchor === "dev"
        ? "Dev anchor"
        : anchor === "mismatch"
          ? "Anchor mismatch"
          : "Unanchored";
  const verifierWord =
    verifier === "independent" ? "independently examined" : verifier === "self" ? "self-attested" : "unverified";
  const label = broken ? "Integrity broken" : `${anchorWord} · ${verifierWord}`;

  const anchorRank = anchor === "onchain" ? 2 : anchor === "dev" ? 1 : 0;
  const verifierRank = verifier === "independent" ? 2 : verifier === "self" ? 1 : 0;
  const rank = broken ? 0 : 1 + anchorRank + verifierRank; // 1..5; broken = 0

  return { label, rank, anchor, verifier, broken };
}

export function scoreBundle(bundle: PublicLedgerBundle, opts: ScoreOptions = {}): VibeScoreResult {
  const c = mergeConstants(opts.constants);
  const penalizeProbeClaims = opts.penalizeProbeClaims ?? false;
  const flags: string[] = [];

  const index = indexGraph(bundle);
  const integrity = computeIntegrity(bundle, index, c, flags);

  const partial = {
    coverage: computeCoverage(index, c, flags),
    claimVerify: computeClaimVerify(bundle, index, penalizeProbeClaims, c, flags),
    verifiedAIDepth: computeVerifiedAIDepth(index),
    traceRichness: computeTraceRichness(index, c),
  };
  const quality = weightedQuality(partial, c.weights);
  const subScores: SubScores = { ...partial, weightedQuality: quality };

  // v2 decomposition: buildScore is the INTRINSIC quality (no anchor/verifier
  // factor); trustWeightedScore is the legacy composite, kept for compatibility.
  const buildScore = clampScore(100 * quality);
  const buildTierInfo = buildTierForScore(buildScore);
  const trustWeightedScore = clampScore(100 * integrity.value * quality);
  const proof = computeProof(bundle, integrity, flags);

  // Legacy composite kept as vibeScore/tier/badge so existing consumers are unbroken.
  const vibeScore = trustWeightedScore;
  const { tier, label } = tierForScore(vibeScore);

  return {
    scoreVersion: 2,
    buildScore,
    buildTier: buildTierInfo.tier,
    buildTierLabel: buildTierInfo.label,
    proof,
    trustWeightedScore,
    vibeScore,
    tier,
    tierLabel: label,
    integrity,
    subScores,
    flags,
    badge: { tier, label, score: vibeScore, seal: integrity.seal },
  };
}
