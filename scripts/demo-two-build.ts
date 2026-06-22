/**
 * Two-build VibeTrace demo: build #1 substantiates its claim,
 * build #2 oversells it ("inflated"). Both run through the SAME attested-run
 * shape and the REAL deriveSummary, so the demo cannot drift from production.
 *
 * Run:  pnpm exec tsx scripts/demo-two-build.ts
 */
import { Wallet, hashMessage } from "ethers";
import { deriveSummary, type RegistrySummary } from "../apps/viewer/registry-core";
import type { PublicLedgerBundle } from "../packages/schema/src/index";

const hx = (seed: string) => "0x" + seed.repeat(64).slice(0, 64);

// Throwaway demo enclave: signs a fixed exec string so the attestation's signature
// RECOVERS to signingAddress and passes the honest TEE display gate
// (recoverAddress(signedDigest, signature) === signingAddress). NOT a real 0G key.
const DEMO_ENCLAVE = new Wallet("0x" + "4".repeat(64));
const DEMO_SIGNED_EXEC = `0x${"a".repeat(64)}:chat-demo`;

/** A bundle whose attested verdict is `verdict` for its single claim. */
async function attestedDemoBundle(opts: {
  project: string;
  commit: string;
  verdict: "substantiated" | "inflated";
}): Promise<PublicLedgerBundle> {
  const supported = opts.verdict === "substantiated";
  const signature = await DEMO_ENCLAVE.signMessage(DEMO_SIGNED_EXEC);
  return {
    manifest: {
      schemaVersion: "vibetrace.v1",
      project: { name: opts.project },
      repo: { root: `/demo/${opts.project}`, commit: opts.commit, branch: "main" },
      createdAt: "2026-06-19T12:00:00.000Z",
      snapshotRoot: hx("1"),
      traceRoot: hx("2"),
      graphRoot: hx("3"),
      publicBundleHash: "pending",
      anchors: []
    },
    publicGraph: {
      nodes: [
        { id: "commit:" + opts.commit, type: "CommitSnapshot", label: opts.commit, data: { createdAt: "2026-06-19T12:00:00.000Z" } },
        { id: "file:src/feature.ts", type: "FileVersion", label: "src/feature.ts", data: { hash: hx("a") } },
        {
          id: "trace:build",
          type: "TraceSpan",
          label: "build",
          data: { tool: "claude-code", model: "opus", promptHash: hx("c"), responseHash: hx("d") }
        }
      ],
      edges: supported ? [{ from: "file:src/feature.ts", to: "claim:feature", type: "supports" }] : [],
      redactionPolicy: "private-by-default",
      canonicalHash: hx("4")
    },
    verifierSummary: {
      verifierId: "vibetrace-0g-compute-adjudicator",
      provider: "0g-compute",
      model: "tee-llm",
      requestHash: hx("5"),
      responseHash: hx("6"),
      outputHash: hx("7"),
      createdAt: "2026-06-19T12:00:00.000Z",
      summary: `Attested adjudication (${opts.verdict})`,
      evidenceTier: "public-only",
      // CANONICAL per-claim verdicts under the tamper hash — what deriveSummary reads for the
      // attested headline (evidenceBadges[].verdict below is just a display mirror).
      verdicts: [{ claimId: "claim:feature", verdict: opts.verdict }],
      attestation: {
        scheme: "0g-teeml",
        attests: "tee-execution",
        providerAddress: "0xprovider",
        // REAL recovering material (the demo must reflect the honest TEE gate).
        signingAddress: DEMO_ENCLAVE.address,
        signature,
        signedDigest: hashMessage(DEMO_SIGNED_EXEC),
        responseTextHash: hx("f"),
        processResponseValid: true,
        verifiedAt: "2026-06-19T12:00:00.000Z",
        verifiedBy: "vibetrace-relayer"
      }
    },
    evidenceBadges: [
      {
        claimId: "claim:feature",
        status: supported ? "verified" : "partial",
        confidence: supported ? 0.9 : 0.4,
        supportingNodes: supported ? ["file:src/feature.ts"] : [],
        publicExplanation: supported
          ? "File-supports edge plus a substantiated enclave verdict."
          : "Linked but the enclave judged the claim oversold.",
        provenance: "structural+attested",
        verdict: opts.verdict
      }
    ],
    storageAnchor: { kind: "storage", provider: "0g-storage", uri: `0g://demo/${opts.commit}`, rootHash: hx("8"), createdAt: "2026-06-19T12:00:00.000Z" },
    chainAnchor: { kind: "chain", provider: "0g-chain", txHash: hx("9"), chainId: 16602, manifestHash: hx("b"), createdAt: "2026-06-19T12:00:00.000Z" }
  } as unknown as PublicLedgerBundle;
}

/** Derive the two demo summary rows through the production deriveSummary. */
export async function buildDemoSummaries(): Promise<RegistrySummary[]> {
  const at = "2026-06-19T12:00:00.000Z";
  return [
    await deriveSummary(await attestedDemoBundle({ project: "PaymentsRewrite", commit: "good01", verdict: "substantiated" }), at),
    await deriveSummary(await attestedDemoBundle({ project: "OAuthClaim", commit: "infl02", verdict: "inflated" }), at)
  ];
}

// CLI entry: print the two attested rows so the demo wiring is visible.
if (import.meta.url === `file://${process.argv[1]}`) {
  buildDemoSummaries()
    .then((rows) => {
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(`${r.project}: verdict=${r.attestedVerdict} teeVerified=${r.teeVerified} substantiated=${r.substantiatedClaims}`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
