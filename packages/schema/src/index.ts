import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";

const hexHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const isoDateSchema = z.string().datetime();

export const traceSpanSchema = z
  .object({
    spanId: z.string().min(1),
    tool: z.string().min(1),
    model: z.string().min(1),
    startedAt: isoDateSchema,
    endedAt: isoDateSchema,
    promptHash: hexHashSchema,
    responseHash: hexHashSchema,
    promptExcerpt: z.string().optional(),
    responseExcerpt: z.string().optional(),
    filesMentioned: z.array(z.string()).default([]),
    artifactsProduced: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export type TraceSpan = z.infer<typeof traceSpanSchema>;

export type SnapshotFile = {
  path: string;
  hash: string;
  size: number;
};

export type CommitSnapshotData = {
  snapshotId: string;
  commit: string;
  branch: string;
  createdAt: string;
  files: SnapshotFile[];
  packageMetadata: Record<string, unknown>;
};

/**
 * What KIND of evidence can support a claim. Gates `supports`-edge generation in
 * @vibetrace/graph so a claim is never "supported" by the wrong evidence:
 *  - "trace":      only files a real AI trace span produced/mentioned (artifactsProduced ∪ filesMentioned)
 *  - "external":   never supported structurally; upgraded only at publish by real 0G/TEE evidence
 *  - "structural": legacy selector/path-substring match (synthetic/test claims only — never a shipped claim)
 */
export type ClaimEvidenceKind = "trace" | "structural" | "external";

export type ClaimInput = {
  claimId: string;
  text: string;
  selectors: string[];
  /** Evidence kind gating support-edge generation. Absent => "structural" (legacy). */
  evidence?: ClaimEvidenceKind;
};

export type ArtifactNodeType =
  | "TraceSpan"
  | "PatchArtifact"
  | "FileVersion"
  | "CommitSnapshot"
  | "ReleaseSnapshot"
  | "Claim"
  | "VerifierRun"
  | "StorageAnchor"
  | "ChainAnchor";

export type ArtifactEdgeType =
  | "produced"
  | "modified"
  | "included_in"
  | "supports"
  | "contradicts"
  | "verified_by"
  | "anchored_by";

export type ArtifactGraphNode = {
  id: string;
  type: ArtifactNodeType;
  label: string;
  data: Record<string, unknown>;
};

export type ArtifactGraphEdge = {
  id: string;
  from: string;
  to: string;
  type: ArtifactEdgeType;
  data?: Record<string, unknown>;
};

export type ArtifactGraph = {
  nodes: ArtifactGraphNode[];
  edges: ArtifactGraphEdge[];
  redactionPolicy: "private-by-default";
  canonicalHash: string;
};

export type LedgerManifest = {
  schemaVersion: "vibetrace.v1";
  project: {
    name: string;
    description?: string;
  };
  repo: {
    root: string;
    commit: string;
    branch?: string;
  };
  createdAt: string;
  snapshotRoot: string;
  traceRoot: string;
  graphRoot: string;
  publicBundleHash: string;
  anchors: Array<StorageAnchor | ChainAnchor>;
};

export type VerifierRun = {
  verifierId: string;
  provider: string;
  model: string;
  requestHash: string;
  responseHash: string;
  outputHash: string;
  createdAt: string;
  summary: string;
  /** Honest record of how much the examiner actually saw (spec §5.1). */
  evidenceTier: "private" | "public-only";
  /** Present iff evidenceTier="private"; Merkle root of the sealed packet. */
  privateEvidenceRoot?: string;
  /**
   * canonicalHash of the full adjudication JSON. Lives on VerifierRun so it
   * rides under the bundle tamper hash via publicLedgerHashPayload (spec §10).
   */
  verdictRoot?: string;
  /** Per-response signature + hardware-quote summary; under the tamper hash. */
  attestation?: TeeAttestation;
  /** Per-claim adjudication verdicts; under the tamper hash. */
  verdicts?: ClaimVerdict[];
};

export type EvidenceBadgeStatus = "verified" | "partial" | "unsupported" | "private";

export interface ClaimVerdict {
  claimId: string;
  verdict: "substantiated" | "inflated" | "unsupported";
  /** Model self-report; advisory DISPLAY only — NEVER fed to the score. */
  confidence: number;
  /**
   * May include `trace:` and `file:` ids — DISPLAY/AUDIT ONLY. Never copied
   * into an EvidenceBadge.supportingNodes (which stays file-only for scoring).
   */
  supportingNodes: string[];
  /** <= 240 chars, cites node ids/paths, no prompt text. */
  rationale: string;
  abstainReason?: "insufficient-public-evidence" | null;
  dimensions: {
    relevance: "strong" | "weak" | "none";
    sufficiency: "proportionate" | "thin" | "absent";
    contradiction: "none" | "present";
  };
}

export interface TeeAttestation {
  scheme: "0g-teeml";
  /**
   * What this signature PROVES. The 0G TeeML enclave signs `responseHash:chatID` and the
   * signature recovers to the `signingAddress` named by the attestation, so it attests that the
   * TEE signer named by this attestation EXECUTED inference for this chatID and committed to a
   * provider-computed response hash. (Recovery proves the signature matches that signer; it does
   * NOT prove the signer is acknowledged in the provider's on-chain registry — VibeTrace does not
   * check that.) It does NOT cryptographically bind the verdict JSON
   * (the substantiated/inflated/unsupported words, confidence, rationale): those are derived
   * from the enclave's response CONTENT and relayed by the operator (trusted transport).
   * Required going forward; legacy bundles may omit it — consumers MUST treat an absent value
   * as not-TEE-attested rather than throwing.
   */
  attests: "tee-execution";
  providerAddress: string;
  signingAddress: string;
  signature: string;
  /** ethers.hashMessage(signedText) — keccak; what the enclave signs. signedText is the
   *  `responseHash:chatID` execution material, NOT the verdict content. */
  signedDigest: string;
  /**
   * canonicalHash(signedText) — SHA-256 over the SIGNED `responseHash:chatID` (the execution
   * material), NOT a hash of the verdict content. There is NO client-verifiable content hash;
   * the verdicts are TEE-execution-attested + relayer-transported. DISTINCT from signedDigest.
   */
  responseTextHash: string;
  /**
   * The enclave-signed execution material `responseHash:chatID` itself. Persisted (NOT transient)
   * so any consumer can independently verify hashMessage(signedText) === signedDigest and that
   * signedText commits to the provider response hash. It is a hash + an opaque chat id — NOT
   * response content, and NOT the `chatSignatureLink` (which retrieves response text and is omitted
   * from public bundles). Optional: legacy bundles omit it; consumers treat absence as "binding not
   * independently checkable here", never as a failure.
   */
  signedText?: string;
  processResponseValid: boolean;
  teeType?: string;
  composeVerificationPassed?: boolean;
  signerAllMatch?: boolean;
  attestationQuoteUri?: string;
  quoteHash?: string;
  raDownloadLink?: string;
  chatSignatureLink?: string;
  verifiedAt: string;
  verifiedBy: string;
}

export type EvidenceBadge = {
  claimId: string;
  status: EvidenceBadgeStatus;
  confidence: number;
  /** File-only (`file:`-prefixed) per the scoring-coupling guard (spec §6). */
  supportingNodes: string[];
  publicExplanation: string;
  /** Set by the deterministic merge. */
  provenance?: "structural+attested" | "structural-only";
  /** The merged adjudication verdict word, for display. */
  verdict?: ClaimVerdict["verdict"];
};

export type StorageAnchor = {
  kind: "storage";
  provider: string;
  uri: string;
  rootHash: string;
  createdAt: string;
};

export type ChainAnchor = {
  kind: "chain";
  provider: string;
  txHash: string;
  chainId: number;
  manifestHash: string;
  createdAt: string;
};

export type PublicLedgerBundle = {
  manifest: LedgerManifest;
  publicGraph: ArtifactGraph;
  verifierSummary: VerifierRun;
  evidenceBadges: EvidenceBadge[];
  storageAnchor: StorageAnchor;
  chainAnchor: ChainAnchor;
  /**
   * Read-back results (VerifyAgainst0G); DELIBERATELY EXCLUDED
   * from publicLedgerHashPayload — re-derived after anchoring, so hashing it
   * would be circular (spec §10).
   */
  verifyAgainst0G?: VerifyAgainst0G;
};

/**
 * Re-derived by reading 0G back AFTER anchoring (download Storage + recompute;
 * read Chain calldata + compare). MUST NOT be included under the bundle hash —
 * hashing it would be circular (spec §10). Stored alongside the bundle for
 * display only.
 */
export interface VerifyAgainst0G {
  storage: { rootHash: string; recomputedHash: string; matches: boolean };
  chain: {
    txHash: string;
    calldataManifestHash: string;
    expectedManifestHash: string;
    matches: boolean;
    readAt: string;
  };
  /**
   * Consumer-verifiable on-chain signer leg (present only for real-compute bundles re-verified with a
   * broker; omitted in dev). Re-fetches the provider's on-chain-acknowledged TEE signer and confirms the
   * bundle's `signingAddress` IS that signer; `quoteVerified` additionally re-runs the live TDX/dstack
   * quote check (best-effort). `matches` = onChainSigner !== null && onChainSigner === expectedSigner
   * (case-insensitive) && acknowledgedOnChain — the reliably re-checkable IDENTITY binding and the actual
   * forger-with-own-keypair closer (a self-minted signer is not the provider's on-chain-acknowledged
   * signer). `quoteVerified` is reported but is NOT part of `matches`: the attestation already embeds the
   * relayer's production-time quote verification, and a transient live-quote miss must not crack a seal
   * whose signer genuinely matches. This does NOT certify the provider is NEUTRAL — a party running their
   * own genuine TeeML provider would also pass; the claim is only "an attested 0G TEE signer executed
   * this," never "a neutral/trusted provider."
   */
  signer?: {
    providerAddress: string;
    expectedSigner: string;
    onChainSigner: string | null;
    acknowledgedOnChain: boolean;
    quoteVerified: boolean;
    matches: boolean;
  };
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

export function canonicalHash(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  return `0x${bytesToHex(sha256(bytes))}`;
}

export function validateTraceSpans(input: unknown): TraceSpan[] {
  return z.array(traceSpanSchema).parse(input);
}

export function redactTraceSpanForPublic(span: TraceSpan): Omit<TraceSpan, "promptExcerpt" | "responseExcerpt"> {
  const { promptExcerpt: _promptExcerpt, responseExcerpt: _responseExcerpt, ...publicSpan } = span;
  return publicSpan;
}

export function hashPublicLedgerBundle(bundle: PublicLedgerBundle): string {
  return canonicalHash(publicLedgerHashPayload(bundle));
}

export function createPublicLedgerBundle(bundle: PublicLedgerBundle): PublicLedgerBundle {
  const withPendingHash: PublicLedgerBundle = {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      publicBundleHash: "pending"
    }
  };
  const publicBundleHash = hashPublicLedgerBundle(withPendingHash);

  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      publicBundleHash
    }
  };
}

export function publicLedgerHashPayload(bundle: PublicLedgerBundle): unknown {
  // The tamper hash names its fields EXPLICITLY. verifierSummary is hashed
  // whole, so attestation / verdicts / verdictRoot ride under the hash for
  // free (spec §10). verifyAgainst0G is DELIBERATELY ABSENT: it is re-derived
  // by reading 0G back after anchoring, so hashing it would be circular.
  return {
    manifest: {
      ...bundle.manifest,
      publicBundleHash: "pending",
      anchors: []
    },
    publicGraph: bundle.publicGraph,
    verifierSummary: bundle.verifierSummary,
    evidenceBadges: bundle.evidenceBadges
  };
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }

  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] !== undefined) {
        normalized[key] = normalizeForCanonicalJson(object[key]);
      }
    }
    return normalized;
  }

  return String(value);
}
