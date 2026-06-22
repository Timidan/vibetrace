import { buildArtifactGraph } from "@vibetrace/graph";
import {
  createPublicLedgerBundle,
  hashPublicLedgerBundle,
  type ClaimInput,
  type CommitSnapshotData,
  type EvidenceBadge,
  type PublicLedgerBundle,
  type TraceSpan,
} from "@vibetrace/schema";
import { runLocalVerifier } from "@vibetrace/verifier";
import { Wallet, hashMessage } from "ethers";

const ZERO = "0x" + "0".repeat(64);
const FIXED_NOW = "2026-06-17T15:08:27.000Z";
const hex = (seed: string) => "0x" + seed.repeat(64).slice(0, 64);

// A throwaway enclave used to mint a REAL recovering TEE-execution attestation for
// the `independentVerifier` fixture path. The signature recovers to `signingAddress`
// so the honest isIndependent gate (provider "0g-compute" + shape + recovery) passes —
// mirrors packages/verifier/src/relayer-client.test.ts. NOT a real 0G key.
const FIXTURE_ENCLAVE = new Wallet("0x" + "2".repeat(64));
const FIXTURE_SIGNED_EXEC = `0x${"a".repeat(64)}:chat-fixture`;

/** A shape-valid TEE attestation whose signature RECOVERS to signingAddress. */
async function recoveringAttestation() {
  const signature = await FIXTURE_ENCLAVE.signMessage(FIXTURE_SIGNED_EXEC);
  return {
    scheme: "0g-teeml" as const,
    attests: "tee-execution" as const,
    providerAddress: "0xfixtureProvider000000000000000000000000aa",
    signingAddress: FIXTURE_ENCLAVE.address,
    signature,
    signedDigest: hashMessage(FIXTURE_SIGNED_EXEC),
    responseTextHash: hex("d"),
    processResponseValid: true,
    verifiedAt: FIXED_NOW,
    verifiedBy: "vibetrace-relayer",
  };
}

export function traceSpan(overrides: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  return {
    spanId: overrides.spanId,
    tool: overrides.tool ?? "codex",
    model: overrides.model ?? "gpt-5",
    startedAt: overrides.startedAt ?? "2026-06-17T10:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-06-17T10:03:00.000Z",
    promptHash: overrides.promptHash ?? hex("a"),
    responseHash: overrides.responseHash ?? hex("b"),
    filesMentioned: overrides.filesMentioned ?? [],
    artifactsProduced: overrides.artifactsProduced ?? [],
    metadata: overrides.metadata ?? {},
  };
}

export function snapshot(opts: {
  commit: string;
  createdAt?: string;
  files: { path: string; size: number; hash?: string }[];
}): CommitSnapshotData {
  return {
    snapshotId: `snapshot:${opts.commit}`,
    commit: opts.commit,
    branch: "no-git",
    createdAt: opts.createdAt ?? "2026-06-17T15:08:26.000Z",
    files: opts.files.map((f) => ({ path: f.path, size: f.size, hash: f.hash ?? hex(f.path.length.toString()) })),
    packageMetadata: { name: "fixture" },
  };
}

export interface MakeBundleOptions {
  traces?: TraceSpan[];
  snapshots?: CommitSnapshotData[];
  claims?: ClaimInput[];
  anchored?: boolean;
  manifestHashOverride?: string;
  verifierModelOverride?: string;
  /** Simulate a REAL independent verifier: provider "0g-compute" + a shape-valid
   *  TEE-execution attestation whose signature RECOVERS to its signingAddress.
   *  Default: the local "0g-dev" verifier, self-verified, never independent. */
  independentVerifier?: boolean;
  evidenceBadgesOverride?: EvidenceBadge[];
  storageRootPresent?: boolean;
}

export async function makeBundle(opts: MakeBundleOptions = {}): Promise<PublicLedgerBundle> {
  const traces = opts.traces ?? [];
  const snapshots = opts.snapshots ?? [];
  const claims = opts.claims ?? [];
  const graph = buildArtifactGraph({ traces, snapshots, claims });

  const verifier = await runLocalVerifier({ graph, now: () => FIXED_NOW });
  const evidenceBadges = opts.evidenceBadgesOverride ?? verifier.evidenceBadges;
  const baseVerifier = opts.verifierModelOverride
    ? { ...verifier.verifierRun, model: opts.verifierModelOverride }
    : verifier.verifierRun;
  // A real INDEPENDENT verifier runs a 0G TeeML enclave (provider "0g-compute")
  // and ships a TEE-execution attestation whose signature recovers to its signer;
  // the default fixture verifier is the LOCAL "0g-dev" one — self-verified, never
  // counted as independent under the honest integrity rules (a bare provider string
  // is forgeable, so the gate requires the recovering attestation too).
  const verifierSummary = opts.independentVerifier
    ? {
        ...baseVerifier,
        provider: "0g-compute",
        verifierId: "0g-compute-fixture",
        attestation: await recoveringAttestation(),
      }
    : baseVerifier;

  const base = createPublicLedgerBundle({
    manifest: {
      schemaVersion: "vibetrace.v1",
      project: { name: "fixture" },
      repo: { root: "/fixture", commit: snapshots[0]?.commit ?? "c0", branch: "no-git" },
      createdAt: FIXED_NOW,
      snapshotRoot: ZERO,
      traceRoot: ZERO,
      graphRoot: graph.canonicalHash,
      publicBundleHash: "pending",
      anchors: [],
    },
    publicGraph: graph,
    verifierSummary,
    evidenceBadges,
    storageAnchor: { kind: "storage", provider: "0g-dev", uri: "0g://local/fixture", rootHash: ZERO, createdAt: FIXED_NOW },
    chainAnchor: { kind: "chain", provider: "0g-dev", txHash: "", chainId: 16602, manifestHash: "pending", createdAt: FIXED_NOW },
  });

  // A GENUINELY independent verifier bundle also carries the live on-chain signer leg
  // (verifyAgainst0G.signer.matches === true) — recovery alone is forgeable, so the honest
  // isIndependent gate requires this on-chain identity binding too. Attach it (the sidecar is
  // EXCLUDED from the bundle hash, so it never affects the manifest/tamper gate) so the fixture
  // models a real independently-verified bundle rather than merely an execution-attested one.
  const signerSidecar: Partial<PublicLedgerBundle> = opts.independentVerifier
    ? {
        verifyAgainst0G: {
          storage: { rootHash: ZERO, recomputedHash: ZERO, matches: true },
          chain: { txHash: "", calldataManifestHash: "pending", expectedManifestHash: "pending", matches: true, readAt: FIXED_NOW },
          signer: {
            providerAddress: "0xfixtureProvider000000000000000000000000aa",
            expectedSigner: FIXTURE_ENCLAVE.address,
            onChainSigner: FIXTURE_ENCLAVE.address,
            acknowledgedOnChain: true,
            quoteVerified: false,
            matches: true,
          },
        },
      }
    : {};

  if (!opts.anchored) {
    return { ...base, ...signerSidecar };
  }

  const manifestHash = opts.manifestHashOverride ?? hashPublicLedgerBundle(base);
  return {
    ...base,
    ...signerSidecar,
    storageAnchor: { ...base.storageAnchor, rootHash: opts.storageRootPresent === false ? "" : manifestHash },
    chainAnchor: { ...base.chainAnchor, provider: "0g-chain", txHash: hex("f"), manifestHash },
  };
}
