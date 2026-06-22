/* ── Per-claim verdict helpers (pure; shared by story + registry) ──
 *
 * These derive the headline verdict from a bundle's per-claim verdicts —
 * `verifierSummary.verdicts` (under the tamper hash; TEE-execution-attested +
 * relayer-transported, NOT a content signature). BOTH the story card
 * (apps/viewer/src/viewer.ts sealState) and the leaderboard row
 * (apps/viewer/registry-core.ts deriveAttestedFields) call these on that SAME
 * source, so the seal word a visitor sees and the leaderboard headline can never
 * disagree. `evidenceBadges[].verdict` is only a per-badge DISPLAY mirror of the
 * same verdicts (see packages/verifier/src/merge.ts) — never the source here.
 *
 * The worst per-claim verdict drives the headline so an inflated / unsupported
 * claim honestly downgrades it. Verdict colors are LOCKED (spec §11):
 * substantiated→lime, inflated→wax, unsupported→sun. Confidence is NEVER rendered
 * as a number — the verdict WORD drives presentation. */

import { recoverAddress } from "ethers";

export type VerdictWord = "substantiated" | "inflated" | "unsupported";
export type VerdictLike = { verdict: VerdictWord };

// Worse = higher rank. unsupported (2) worse than inflated (1) worse than substantiated (0).
const VERDICT_RANK: Record<VerdictWord, number> = { substantiated: 0, inflated: 1, unsupported: 2 };

/** The worst verdict across all per-claim verdicts, or null when none are present. */
export function worstVerdict(verdicts: VerdictLike[] | undefined): VerdictWord | null {
  if (!verdicts || verdicts.length === 0) return null;
  let worst: VerdictWord = "substantiated";
  for (const v of verdicts) {
    if (VERDICT_RANK[v.verdict] > VERDICT_RANK[worst]) worst = v.verdict;
  }
  return worst;
}

/** Locked display word + Neo-Brutal color class for a verdict. wax is reserved for INFLATED. */
export function verdictWordAndClass(verdict: VerdictWord): { word: string; cls: string } {
  switch (verdict) {
    case "substantiated":
      return { word: "SUBSTANTIATED", cls: "bg-lime text-ink" };
    case "inflated":
      return { word: "INFLATED", cls: "bg-wax text-paperlight" };
    case "unsupported":
      return { word: "UNSUPPORTED", cls: "bg-sun text-ink" };
  }
}

/** Headline stat split: "N substantiated · M flagged" (flagged = inflated + unsupported). */
export function substantiatedFlaggedCounts(
  verdicts: VerdictLike[] | undefined
): { substantiated: number; flagged: number } {
  if (!verdicts || verdicts.length === 0) return { substantiated: 0, flagged: 0 };
  let substantiated = 0;
  let flagged = 0;
  for (const v of verdicts) {
    if (v.verdict === "substantiated") substantiated++;
    else flagged++;
  }
  return { substantiated, flagged };
}

/* ── Shared display-eligibility gate for the TEE-execution attestation ──
 *
 * The SINGLE shape predicate used by BOTH the story-page seal
 * (apps/viewer/src/viewer.ts sealState) and the leaderboard row
 * (apps/viewer/registry-core.ts deriveAttestedFields) so a bundle can never be
 * "attested" in one surface and not the other. Display-eligible means the 0G TeeML
 * signer NAMED BY the attestation EXECUTED inference and the signature recovers to it
 * — NOT that the verdict content was signed, and NOT that VibeTrace verified the signer
 * against an on-chain registry. Legacy bundles missing `attests`/`scheme`/the signature
 * fields are NOT display-eligible (treated as not-TEE-attested, never thrown on). */

/** The minimal attestation shape both surfaces read. Kept structural so callers
 *  can pass the raw `verifierSummary.attestation` (TeeAttestation | undefined). */
export type DisplayEligibleAttestationLike = {
  scheme?: string;
  attests?: string;
  processResponseValid?: boolean;
  signingAddress?: string;
  signature?: string;
  signedDigest?: string;
};

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * True when the attestation is valid for display as a TEE-execution seal:
 * 0g-teeml scheme, `attests: "tee-execution"`, a passing processResponse,
 * non-empty signingAddress + signature + signedDigest, AND the signature
 * cryptographically RECOVERS to signingAddress (recoverAddress(signedDigest,
 * signature) === signingAddress, wrapped in try/catch → false). Shape alone is
 * forgeable — a hand-crafted bundle could set any signer/signature/digest — so
 * the recovery check (the SAME boundary score's isIndependent + the relayer's
 * validateAttestationLocally use) is required before any TEE pill / "attested"
 * seal / marquee mark renders. Does NOT consult the provider or the 0G read-back
 * sidecar — callers add those (provider === "0g-compute" and the verifyAgainst0G
 * mismatch check) as fail-closed gates.
 *
 * SCOPE: this is the static, in-page display gate (recovery only). Two STRONGER checks live
 * elsewhere now: (1) the bundle persists `signedText`, so a consumer can verify
 * hashMessage(signedText) === signedDigest (score's isIndependent enforces it when present); and
 * (2) `verifyAgainst0G.signer` carries a consumer re-verification of the signer against the
 * provider's on-chain-acknowledged + quote-verified TEE signer — see verifyAgainst0GMismatch, which
 * cracks the seal when `signer.matches === false`. The verdict itself stays trusted-transport (0G
 * signs the digest, not the verdict JSON) — a 0G protocol property, not a gap we can close here.
 */
export function isDisplayEligibleAttestation(
  attestation: DisplayEligibleAttestationLike | undefined | null
): attestation is DisplayEligibleAttestationLike {
  if (!attestation) return false;
  const shapeValid =
    attestation.scheme === "0g-teeml" &&
    attestation.attests === "tee-execution" &&
    attestation.processResponseValid === true &&
    nonEmptyString(attestation.signingAddress) &&
    nonEmptyString(attestation.signature) &&
    nonEmptyString(attestation.signedDigest);
  if (!shapeValid) return false;
  try {
    return (
      recoverAddress(attestation.signedDigest as string, attestation.signature as string).toLowerCase() ===
      (attestation.signingAddress as string).toLowerCase()
    );
  } catch {
    return false;
  }
}

/** A 0G read-back sidecar (DELIBERATELY structural so both surfaces share it). */
export type VerifyAgainst0GLike = {
  storage?: { matches?: boolean };
  chain?: { matches?: boolean };
  signer?: { matches?: boolean };
};

/**
 * Fail-closed read-back check: when a verifyAgainst0G sidecar is PRESENT, storage, chain, AND (when a
 * signer leg was recorded) the signer must not be `false`. Returns true when the on-chain evidence
 * disagrees with the bundle (a mismatch the seal must crack on). Absent sidecar / absent signer leg →
 * not a mismatch (no such read-back was attempted; nothing to contradict).
 */
export function verifyAgainst0GMismatch(sidecar: VerifyAgainst0GLike | undefined | null): boolean {
  if (!sidecar) return false;
  return (
    sidecar.storage?.matches === false ||
    sidecar.chain?.matches === false ||
    sidecar.signer?.matches === false
  );
}
