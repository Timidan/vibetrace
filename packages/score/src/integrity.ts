import { hashPublicLedgerBundle, type CommitSnapshotData, type PublicLedgerBundle } from "@vibetrace/schema";
import { hashMessage, recoverAddress } from "ethers";
import { type GraphIndex, nodesOfType } from "./graph-index";
import type { IntegrityResult, ScoreConstants } from "./types";

const HEX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fileHashesConsistent(index: GraphIndex): boolean {
  for (const file of nodesOfType(index, "FileVersion")) {
    const path = String(file.data.path);
    const commit = String(file.data.commit);
    const commitNode = index.nodeById.get(`commit:${commit}`);
    if (!commitNode) return false;
    const files = (commitNode.data as CommitSnapshotData).files ?? [];
    const entry = files.find((f) => f.path === path);
    if (!entry || entry.hash !== String(file.data.hash)) return false;
  }
  return true;
}

function isIndependent(bundle: PublicLedgerBundle): boolean {
  // "Independent verification" is the STRONGEST trust word — it earns full verifier trust and the
  // `anchored-verified` seal / "independently verified" label. Reserve it for bundles that carry BOTH:
  //   (a) a shape-valid 0g-compute TEE-EXECUTION attestation whose `signature` recovers to the declared
  //       `signingAddress` (same boundary as validateAttestationLocally + the viewer seal gate), AND
  //   (b) a LIVE on-chain signer leg — verifyAgainst0G.signer.matches === true — confirming that signer
  //       IS the provider's on-chain-acknowledged TEE signer.
  //
  // Recovery ALONE is forgeable: a party using their OWN keypair signs and names their own
  // `signingAddress`, so the signature recovers — that proves EXECUTION by *some* signer, NOT an
  // INDEPENDENT one. The on-chain signer leg is the documented forger-with-own-keypair closer (a
  // self-minted signer is not the provider's on-chain-acknowledged signer), so it is what the
  // "independent" word actually rests on. A bundle with a recovering attestation but NO signer leg
  // (or signer.matches !== true) is "TEE execution-attested, signer not independently re-verified":
  // it still earns the attested DISPLAY (teeVerified) but NOT independent verifier trust here.
  const provider = String(bundle.verifierSummary.provider ?? "").toLowerCase();
  if (provider !== "0g-compute") return false;

  const att = bundle.verifierSummary.attestation;
  if (!att) return false;
  const shapeValid =
    att.scheme === "0g-teeml" &&
    att.attests === "tee-execution" &&
    att.processResponseValid === true &&
    nonEmptyString(att.signingAddress) &&
    nonEmptyString(att.signature) &&
    nonEmptyString(att.signedDigest);
  if (!shapeValid) return false;

  // When signedText is persisted, the digest MUST be over exactly that material.
  if (nonEmptyString(att.signedText) && hashMessage(att.signedText) !== att.signedDigest) return false;

  let recovers: boolean;
  try {
    recovers = recoverAddress(att.signedDigest, att.signature).toLowerCase() === att.signingAddress.toLowerCase();
  } catch {
    return false;
  }
  if (!recovers) return false;

  // INDEPENDENCE GATE: the signature recovered, but that only proves execution by the declared signer.
  // Require the live on-chain signer leg to prove that signer is the provider's acknowledged TEE signer.
  return bundle.verifyAgainst0G?.signer?.matches === true;
}

function isValidHash(value: unknown): boolean {
  return typeof value === "string" && HEX_HASH_RE.test(value);
}

function hasUsableVerifier(bundle: PublicLedgerBundle): boolean {
  const vs = bundle.verifierSummary;
  return Boolean(
    vs &&
      vs.model &&
      vs.summary &&
      isValidHash(vs.requestHash) &&
      isValidHash(vs.responseHash) &&
      isValidHash(vs.outputHash)
  );
}

export function computeIntegrity(
  bundle: PublicLedgerBundle,
  index: GraphIndex,
  c: ScoreConstants,
  flags: string[],
): IntegrityResult {
  // --- Anchor ---
  let anchorValue: number;
  let anchored = false;
  const manifest = bundle.chainAnchor.manifestHash;
  const hasManifest = manifest !== "" && manifest !== "pending";
  // A "0g-dev"/pending chain anchor was never broadcast — its txHash is a local
  // synthetic hash, so it must NOT earn on-chain anchor credit. Only a real chain
  // provider (e.g. "0g-chain") counts as anchored; dev anchors fall to the
  // unanchored ceiling and seal as "self-published". We gate on the CHAIN
  // provider only, since the minimal real-chain mode keeps storage local.
  const chainProvider = String(bundle.chainAnchor.provider ?? "").toLowerCase();
  // STRICT: only the real on-chain adapter's provider ("0g-chain") earns anchor
  // credit. Any other value — including a forged "0g" / "fake-chain" — is NOT
  // on-chain anchored. (Security + technical review #1: a forged provider must
  // never earn anchored credit without a real verified 0G transaction.)
  const realChainProvider = chainProvider === "0g-chain";
  const onChainAnchored =
    realChainProvider && Boolean(bundle.chainAnchor.txHash) && hasManifest && Boolean(bundle.storageAnchor.rootHash);

  if (!fileHashesConsistent(index)) {
    anchorValue = c.anchor.broken;
    flags.push("hash-decoupled");
  } else if (hasManifest && hashPublicLedgerBundle(bundle) !== manifest) {
    // Tamper gate: the bundle content no longer matches its own recorded
    // manifest hash. This collapses the score regardless of anchor provider —
    // it must fire for dev bundles too, not just on-chain ones.
    anchorValue = c.anchor.broken;
    flags.push("manifest-mismatch");
  } else if (onChainAnchored) {
    anchorValue = c.anchor.full;
    anchored = true;
  } else {
    anchorValue = c.anchor.unanchoredCeiling;
    flags.push("unanchored");
  }

  // --- VerifierTrust ---
  let verifierValue: number;
  let verified = false;
  if (!hasUsableVerifier(bundle)) {
    verifierValue = c.verifierTrust.absent;
    flags.push("no-verifier");
  } else if (isIndependent(bundle)) {
    verifierValue = c.verifierTrust.independent;
    verified = true;
  } else {
    verifierValue = c.verifierTrust.selfVerified;
    flags.push("self-verified");
  }

  const value = anchorValue * verifierValue;
  const seal: IntegrityResult["seal"] =
    anchorValue === c.anchor.broken ? "broken" : anchored && verified ? "anchored-verified" : anchored ? "anchored" : "self-published";

  return { value, anchored, verified, seal };
}
