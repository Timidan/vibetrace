/**
 * The single source of truth for a leaderboard row. Shared by BOTH the server
 * (apps/viewer/registry-core.ts) and the client (apps/viewer/src/registry.ts) so
 * the two can never drift. Type-only — no runtime coupling between server/client.
 */
export type RegistrySummary = {
  id: string;
  project: string;
  repo: string;
  tools: { tool: string; model: string }[];
  /** @deprecated legacy trust-weighted composite. Prefer buildScore + proofLabel. */
  vibeScore: number;
  /** @deprecated legacy composite tier. Prefer buildTier. */
  tier: string;
  tierLabel: string;
  seal: string;
  anchored: boolean;
  /** v2 Build/Proof decomposition: buildScore = intrinsic AI-build quality
   *  (process-independent); proof = the trust/notarization status, separated out. */
  scoreVersion: number;
  buildScore: number;
  buildTier: string;
  buildTierLabel: string;
  proofLabel: string;
  proofRank: number;
  trustWeightedScore: number;
  fileCount: number;
  verifiedClaims: number;
  /** True iff this build carries a TEE-EXECUTION attestation: provider === "0g-compute" AND
   *  attestation.attests === "tee-execution" AND attestation.processResponseValid AND scheme
   *  "0g-teeml" with a signer present, AND recoverAddress(signedDigest, signature) === signingAddress.
   *  (Execution attested by the provider's 0G TEE signer named by the attestation — the signature
   *  recovers to that signer; we do NOT check it against the provider's on-chain registry. The verdict content is
   *  relayer-transported, NOT content-signed.) Legacy bundles missing
   *  `attests` are NOT shown as TEE-attested. Lets the marquee/leaderboard flag attested builds
   *  pre-click. Display-only. */
  teeVerified: boolean;
  /** The WORST per-claim verdict (mirrors the card headline), or null when no verdicts are
   *  present. Display-only; never fed to scoring. */
  attestedVerdict: "substantiated" | "inflated" | "unsupported" | null;
  /** Count of evidence badges judged "substantiated". Display-only. */
  substantiatedClaims: number;
  /** Server-side display timestamp (ISO). Never used in scoring. */
  submittedAt: string;
  bundleHash: string;
};
