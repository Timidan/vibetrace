import { ArtifactGraph, ClaimVerdict, EvidenceBadge, VerifierRun, canonicalHash } from "@vibetrace/schema";
import { buildMergedEvidenceBadges, mergeEvidenceBadge } from "./merge";
import {
  runAttestedAdjudicator,
  type AttestedAdjudicatorOptions,
  type BrokerLike,
  type QuoteStorage
} from "./attested-adjudicator";
export { buildMergedEvidenceBadges, mergeEvidenceBadge } from "./merge";
import { runRelayerAdjudication, validateAttestationLocally } from "./relayer-client";

export {
  runAttestedAdjudicator,
  selectTeeMlProvider,
  NoTeeMlProviderError,
  buildAdjudicationRequest,
  crossCheckAdjudication,
  buildTeeAttestation,
  type AttestedAdjudicatorOptions,
  type AttestedResult,
  type BrokerLike,
  type ServiceSummary,
  type QuoteStorage
} from "./attested-adjudicator";
export { adjudicationV1Schema, parseAdjudicationV1, type AdjudicationV1 } from "./adjudication-schema";
export { buildStructuralSupportSet, buildStructuralNeighborhood } from "./structural-support";
export { runRelayerAdjudication, validateAttestationLocally } from "./relayer-client";
export { verifySignerAgainst0G, type SignerVerification } from "./signer-verify";

export type VerifierResult = {
  verifierRun: VerifierRun;
  evidenceBadges: EvidenceBadge[];
  /** TRANSIENT: the exact text the enclave put its signature over — `responseHash:chatID` (the EXECUTION
   *  material, NOT the verdict JSON). Used client-side to re-derive the TEE-EXECUTION proof
   *  (validateAttestationLocally), then discarded — NEVER persisted in the public bundle. */
  signedText?: string;
};

export type RunLocalVerifierOptions = {
  graph: ArtifactGraph;
  now?: () => string;
};

export async function runLocalVerifier(options: RunLocalVerifierOptions): Promise<VerifierResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const evidenceBadges = buildEvidenceBadges(options.graph);
  const output = {
    graphHash: options.graph.canonicalHash,
    evidenceBadges,
    summary: summarizeGraph(options.graph, evidenceBadges)
  };

  return {
    verifierRun: {
      verifierId: "vibetrace-local-verifier",
      provider: "0g-dev",
      model: "deterministic-lineage-verifier",
      requestHash: canonicalHash({
        graphHash: options.graph.canonicalHash,
        nodeCount: options.graph.nodes.length,
        edgeCount: options.graph.edges.length
      }),
      responseHash: canonicalHash(output),
      outputHash: canonicalHash(output),
      createdAt: now(),
      summary: output.summary,
      evidenceTier: "public-only"
    },
    evidenceBadges
  };
}

export async function runVibeTraceVerifier(options: {
  graph: ArtifactGraph;
  env?: NodeJS.ProcessEnv;
  broker?: BrokerLike;
  quoteStorage?: QuoteStorage;
  relayerUrl?: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  preferredProvider?: string;
  verifiedBy?: string;
  now?: () => string;
}): Promise<VerifierResult> {
  const env = options.env ?? process.env;

  // Server path: the hosted relayer supplies a broker + a quote-storage sink and runs the
  // attested adjudicator directly (it holds the funded key).
  if (options.broker && options.quoteStorage) {
    const adjOptions: AttestedAdjudicatorOptions = {
      graph: options.graph,
      broker: options.broker,
      quoteStorage: options.quoteStorage,
      fetchImpl: options.fetchImpl,
      preferredProvider: options.preferredProvider,
      verifiedBy: options.verifiedBy ?? "vibetrace-relayer",
      now: options.now
    };
    return runAttestedAdjudicator(adjOptions);
  }

  // CLI product path: no funded key locally, so delegate the JUDGMENT leg to the hosted
  // relayer, then re-validate its attestation with LOCAL crypto. This is the DEFAULT for
  // `npx vibetrace` whenever VIBETRACE_RELAYER_URL is configured. The attestation attests
  // EXECUTION (the signature over `responseHash:chatID` recovers to the on-chain TEE signer),
  // NOT the verdict content — verdicts are trusted-transport, gated CLIENT-SIDE by the
  // one-directional support gate. An attestation that fails LOCAL validation (bad signer / tier
  // mismatch / verdictRoot inconsistency) falls through to the structural-only floor.
  const relayerUrl = options.relayerUrl ?? env.VIBETRACE_RELAYER_URL;
  if (relayerUrl) {
    try {
      return await runRelayerAdjudication({
        graph: options.graph,
        relayerUrl,
        authToken: options.authToken ?? env.VIBETRACE_RELAYER_AUTH_TOKEN,
        fetchImpl: options.fetchImpl,
        now: options.now
      });
    } catch (err) {
      // Honest fallback (spec §6): relayer unreachable or returned an unverifiable
      // attestation → structural-only local verifier, never a fabricated attested run.
      // Surface WHY on stderr — a silent drop from "independently examined" to structural-only
      // is otherwise invisible to the operator (the attested leg just never appears).
      console.error(`⚠ attested adjudication unavailable — falling back to structural-only verifier: ${(err as Error)?.message ?? err}`);
      return runLocalVerifier({ graph: options.graph, now: options.now });
    }
  }

  return runLocalVerifier({ graph: options.graph, now: options.now });
}

function buildEvidenceBadges(graph: ArtifactGraph, verdicts?: ClaimVerdict[]): EvidenceBadge[] {
  return buildMergedEvidenceBadges(graph, verdicts);
}

function summarizeGraph(graph: ArtifactGraph, badges: EvidenceBadge[]): string {
  const traceCount = graph.nodes.filter((node) => node.type === "TraceSpan").length;
  const fileCount = graph.nodes.filter((node) => node.type === "FileVersion").length;
  const verifiedCount = badges.filter((badge) => badge.status === "verified").length;
  return `VibeTrace linked ${traceCount} AI trace span${traceCount === 1 ? "" : "s"} to ${fileCount} file version${fileCount === 1 ? "" : "s"} and verified ${verifiedCount} public claim${verifiedCount === 1 ? "" : "s"}.`;
}
