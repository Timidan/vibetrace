import type { ArtifactGraph, EvidenceBadge, VerifierRun } from "@vibetrace/schema";
import { canonicalHash } from "@vibetrace/schema";
import { hashMessage, recoverAddress } from "ethers";
import { buildMergedEvidenceBadges, downgradeUnsupportedVerdicts } from "./merge";
import { dropTruncatedNegativesOnCap } from "./attested-adjudicator";

export type VerifierResult = {
  verifierRun: VerifierRun;
  evidenceBadges: EvidenceBadge[];
  /** TRANSIENT transport field: the exact text the enclave put its signature over —
   *  `responseHash:chatID` (the EXECUTION material). Used to re-derive the TEE-execution proof
   *  client-side (validateAttestationLocally), then MOVED onto `verifierRun.attestation.signedText`
   *  (persisted there so consumers can re-verify the digest binding) and removed from the top level.
   *  It is NOT the verdict JSON and NOT response content. */
  signedText?: string;
};

/**
 * Re-verify a relayer-returned attestation with LOCAL crypto only.
 *
 * HONEST BOUNDARY: the 0G TeeML enclave signs `responseHash:chatID` (TEE EXECUTION + a provider
 * response-hash), NOT the verdict JSON. So this function proves the EXECUTION material is genuine
 * (recovers to the signer named by the attestation; we do NOT check that signer is acknowledged
 * on-chain) and that the persisted verdicts are self-consistent
 * with `verdictRoot` (tamper hygiene). It does NOT — and cannot — prove the verdict WORDS came from
 * the enclave: those are derived from the enclave's response content and relayed by the operator
 * (trusted transport). The one-directional merge gate + the local badge recompute (runRelayerAdjudication)
 * are what stop a relayer from promoting a no-support claim — not this signature.
 *
 * `signedText` is the `responseHash:chatID` execution material — returned transiently by the relayer
 * and then PERSISTED onto `run.attestation.signedText` (see runRelayerAdjudication), so a consumer
 * re-verifies the binding by passing `run.attestation.signedText` back into this function.
 * ALL of these must hold:
 *   1. processResponse passed inside the enclave;
 *   2. hashMessage(signedText) === signedDigest (the digest is over THIS execution material);
 *   3. canonicalHash(signedText) === responseTextHash (SHA-256 tie to our hash world);
 *   4. recoverAddress(signedDigest, signature) === signingAddress (TEE-EXECUTION proof);
 *   5. canonicalHash(run.verdicts ?? []) === verdictRoot — tamper-hygiene over the PERSISTED verdicts
 *      (a hostile relayer CAN make this self-consistent; it is NOT a cryptographic/TEE verdict binding).
 * When `expected` is supplied, the run's evidenceTier + privateEvidenceRoot must also match the request
 * (consistency only — the graph is NOT re-bound here, see the inline note at the check).
 */
export function validateAttestationLocally(
  run: VerifierRun,
  signedText: string,
  expected?: { evidenceTier?: string; privateEvidenceRoot?: string }
): { valid: boolean; reason?: string } {
  const att = run.attestation;
  if (!att) {
    return { valid: false, reason: "no attestation present" };
  }
  if (typeof signedText !== "string" || signedText.length === 0) {
    return { valid: false, reason: "no signedText to verify the TEE execution" };
  }
  if (att.processResponseValid !== true) {
    return { valid: false, reason: "processResponseValid is not true" };
  }
  const digest = hashMessage(signedText);
  if (digest !== att.signedDigest) {
    return { valid: false, reason: "hashMessage(signedText) !== signedDigest" };
  }
  if (canonicalHash(signedText) !== att.responseTextHash) {
    return { valid: false, reason: "canonicalHash(signedText) !== responseTextHash" };
  }
  try {
    const recovered = recoverAddress(digest, att.signature);
    if (recovered.toLowerCase() !== att.signingAddress.toLowerCase()) {
      return { valid: false, reason: `signature recovers to ${recovered}, not ${att.signingAddress}` };
    }
  } catch (error) {
    return { valid: false, reason: `signature recover failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // TAMPER HYGIENE (NOT a TEE/crypto binding): the persisted verdicts must hash to the persisted
  // verdictRoot, so a verdictRoot left over from a different run, or a substituted run.verdicts, is
  // caught. A hostile relayer CAN make these self-consistent — the verdict WORDS are TEE-execution-
  // attested + relayer-transported, then gated by the local badge recompute (runRelayerAdjudication).
  if (canonicalHash(run.verdicts ?? []) !== run.verdictRoot) {
    return { valid: false, reason: "canonicalHash(run.verdicts) !== verdictRoot — verdicts not self-consistent" };
  }
  // CONSISTENCY (tamper hygiene, NOT a cryptographic binding): the run's declared evidenceTier and
  // privateEvidenceRoot must match what the client requested, so a private-tier run is not relayed as
  // if it answered a public-only request (and vice versa). The graph itself is NOT re-bound here — the
  // producer's requestHash is computed over private leaves the client does not hold on the private path,
  // so it is not client-reproducible; we deliberately check ONLY the fields we actually have.
  if (expected) {
    if (run.evidenceTier !== undefined) {
      const expectedTier = expected.evidenceTier ?? "public-only";
      if (run.evidenceTier !== expectedTier) {
        return { valid: false, reason: `run.evidenceTier ${run.evidenceTier} !== expected ${expectedTier}` };
      }
    }
    if (expected.privateEvidenceRoot !== undefined && run.privateEvidenceRoot !== expected.privateEvidenceRoot) {
      return { valid: false, reason: `run.privateEvidenceRoot !== expected` };
    }
  }
  return { valid: true };
}

export async function runRelayerAdjudication(options: {
  graph: ArtifactGraph;
  relayerUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => string;
  /** When present, sent to the relayer so the TEE sees the sealed evidence. */
  evidenceTier?: "public-only" | "private";
  privateEvidenceRoot?: string;
  privatePacket?: unknown;
}): Promise<VerifierResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.relayerUrl.replace(/\/$/, "");
  // Optional bearer: send iff a token is configured (the relayer enforces auth iff IT sets one).
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.authToken) headers["Authorization"] = `Bearer ${options.authToken}`;
  const response = await fetchImpl(`${base}/adjudicate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      graph: options.graph,
      evidenceTier: options.evidenceTier ?? "public-only",
      ...(options.privateEvidenceRoot !== undefined ? { privateEvidenceRoot: options.privateEvidenceRoot } : {}),
      ...(options.privatePacket !== undefined ? { privatePacket: options.privatePacket } : {})
    }),
    signal: options.signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`relayer /adjudicate HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const result = (await response.json()) as VerifierResult;
  // Re-derive the TEE-EXECUTION proof from the transient signedText (`responseHash:chatID`), then
  // discard it. This proves the TEE signer named by the attestation executed inference (signature
  // recovers to that signer; on-chain acknowledgement is NOT checked) and that the persisted verdicts
  // are self-consistent with verdictRoot — it does NOT prove
  // the verdict words came from the enclave (trusted transport). Absent signedText means the relayer
  // did not supply the execution material, which is treated as a failed validation.
  const check = validateAttestationLocally(result.verifierRun, result.signedText ?? "", {
    evidenceTier: options.evidenceTier ?? "public-only",
    privateEvidenceRoot: options.privateEvidenceRoot
  });
  if (!check.valid) {
    throw new Error(`relayer returned an attestation that failed LOCAL validation: ${check.reason}`);
  }
  // PERSIST the execution material onto the attestation (it is `responseHash:chatID` — a hash + an
  // opaque id, NOT response content) so any downstream consumer can independently re-run
  // validateAttestationLocally and confirm hashMessage(signedText) === signedDigest. Then remove the
  // transient top-level copy. Validation above already proved this signedText hashes to signedDigest.
  if (result.verifierRun.attestation && result.signedText) {
    result.verifierRun.attestation.signedText = result.signedText;
  }
  delete (result as { signedText?: string }).signedText; // transient top-level copy — lives on the attestation now
  // TIER-AWARE HONESTY GATE: never trust the relayer's VERDICT WORDS for a no-support claim. The verdicts
  // are TEE-execution-attested + relayer-transported (the enclave signature does NOT bind the verdict
  // content), so a hostile/buggy relayer could hand a no-support claim a "substantiated" word that the
  // viewer/registry HEADLINE would display.
  //
  // On the PUBLIC-only path we re-apply the SAME one-directional public-support gate CLIENT-SIDE against
  // the client's own graph: downgrade no-support positive verdicts to "unsupported", recompute verdictRoot
  // over the downgraded array, then recompute the public badges. On the PRIVATE path we MUST NOT apply the
  // public-support downgrade — a private-tier verdict is legitimately substantiated by packet evidence that
  // has no public `supports` edge. The authoritative private gate is the CLI's upgradeVerdictsWithPacket +
  // packetCoversClaim (one-directional, evidence-leaf-keyed), applied in runPrivatePacketAdjudication.
  const isPrivate = (options.evidenceTier ?? "public-only") === "private";
  if (!isPrivate) {
    // PARITY with the producer's public-path filters (defense-in-depth, in dependency order):
    // (1) dropTruncatedNegativesOnCap — a NEGATIVE verdict for a claim whose candidate table was
    //     truncated is untrustworthy (the model never saw the hidden tail); drop it to the structural
    //     floor so a buggy/hostile relayer can't surface a false negative on a heavily-supported claim.
    // (2) downgradeUnsupportedVerdicts — never let a no-support POSITIVE word survive. Both only ever
    // move toward the safe floor; verdictRoot is then recomputed over the client's own gated array.
    const gated = downgradeUnsupportedVerdicts(
      options.graph,
      dropTruncatedNegativesOnCap(options.graph, result.verifierRun.verdicts ?? [])
    );
    result.verifierRun.verdicts = gated;
    result.verifierRun.verdictRoot = canonicalHash(gated);
    result.evidenceBadges = buildMergedEvidenceBadges(options.graph, gated);
  }
  return result;
}
