import { describe, expect, it } from "vitest";
import { Wallet, hashMessage } from "ethers";
import type { ClaimVerdict, VerifierRun } from "@vibetrace/schema";
import { canonicalHash } from "@vibetrace/schema";
import { validateAttestationLocally, runRelayerAdjudication } from "./relayer-client";

const enclave = new Wallet("0x" + "2".repeat(64));

// REAL 0G TeeML execution material: the enclave signs `responseHash:chatID` (NOT the verdict JSON).
const SIGNED_EXEC = `0x${"a".repeat(64)}:chat-670332c`;

// The PERSISTED verdicts come from the enclave's response CONTENT (cross-checked against the graph),
// relayed by the operator. They are NOT in the signed execution material.
const VERDICTS: ClaimVerdict[] = [
  {
    claimId: "claim:storage",
    verdict: "substantiated",
    confidence: 0.8,
    supportingNodes: ["file:src/storage.ts@abc"],
    rationale: "uses 0G storage",
    abstainReason: null,
    dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
  }
];

// Build an attested run internally consistent with `signedText` (the execution material) and its
// persisted verdicts (verdictRoot = canonicalHash(verdicts)). Each test perturbs exactly one thing.
async function attestedRun(
  signedText: string,
  overrides: Partial<NonNullable<VerifierRun["attestation"]>> = {},
  runOverrides: Partial<VerifierRun> = {}
): Promise<VerifierRun> {
  const signature = await enclave.signMessage(signedText);
  const verdicts = (runOverrides.verdicts ?? VERDICTS) as ClaimVerdict[];
  return {
    verifierId: "vibetrace-attested-adjudicator",
    provider: "0g-compute",
    model: "llm-x",
    requestHash: "0x" + "1".repeat(64),
    responseHash: "0x" + "1".repeat(64),
    outputHash: "0x" + "1".repeat(64),
    createdAt: "2026-06-19T00:00:00.000Z",
    summary: "judged",
    evidenceTier: "public-only",
    verdicts,
    verdictRoot: canonicalHash(verdicts),
    attestation: {
      scheme: "0g-teeml",
      attests: "tee-execution",
      providerAddress: "0xGood",
      signingAddress: enclave.address,
      signature,
      signedDigest: hashMessage(signedText),
      responseTextHash: canonicalHash(signedText),
      processResponseValid: true,
      verifiedAt: "2026-06-19T00:00:00.000Z",
      verifiedBy: "vibetrace-relayer",
      ...overrides
    },
    ...runOverrides
  } as VerifierRun;
}

describe("validateAttestationLocally", () => {
  it("accepts a run whose signedText is `responseHash:chatID` and whose verdicts hash to verdictRoot", async () => {
    const run = await attestedRun(SIGNED_EXEC);
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(true);
  });

  it("rejects when processResponseValid is false", async () => {
    const run = await attestedRun(SIGNED_EXEC, { processResponseValid: false } as any);
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(false);
  });

  it("rejects when the signature recovers to a different address (substituted signer — TEE-execution proof fails)", async () => {
    const run = await attestedRun(SIGNED_EXEC, { signingAddress: "0x" + "0".repeat(40) } as any);
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(false);
  });

  it("rejects a run with no attestation", () => {
    const run = { provider: "0g-dev", attestation: undefined } as unknown as VerifierRun;
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(false);
  });

  it("rejects when verdictRoot does NOT match canonicalHash(run.verdicts) (tamper hygiene)", async () => {
    const run = await attestedRun(SIGNED_EXEC, {}, { verdictRoot: "0x" + "7".repeat(64) });
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(false);
  });

  it("rejects when run.verdicts are substituted but verdictRoot is left stale (self-consistency)", async () => {
    // Keep the ORIGINAL verdictRoot (for VERDICTS) but swap the verdicts to a different value.
    const tampered = [{ ...VERDICTS[0], verdict: "unsupported" as const }];
    const run = await attestedRun(SIGNED_EXEC);
    (run as { verdicts?: ClaimVerdict[] }).verdicts = tampered; // verdictRoot still hashes the ORIGINAL
    expect(validateAttestationLocally(run, SIGNED_EXEC).valid).toBe(false);
  });

  it("rejects when signedText is altered after signing (digest mismatch — execution material tampered)", async () => {
    const run = await attestedRun(SIGNED_EXEC);
    expect(validateAttestationLocally(run, SIGNED_EXEC + " ").valid).toBe(false);
  });

  it("rejects a run whose declared evidenceTier does not match the request (consistency check)", async () => {
    const run = await attestedRun(SIGNED_EXEC, {}, { evidenceTier: "private" });
    // Client expected public-only; the run claims private → mismatch.
    expect(
      validateAttestationLocally(run, SIGNED_EXEC, { evidenceTier: "public-only" }).valid
    ).toBe(false);
    // Matching tier validates.
    expect(
      validateAttestationLocally(await attestedRun(SIGNED_EXEC), SIGNED_EXEC, {
        evidenceTier: "public-only"
      }).valid
    ).toBe(true);
  });

  it("rejects a run whose declared privateEvidenceRoot does not match the request", async () => {
    const run = await attestedRun(SIGNED_EXEC, {}, { evidenceTier: "private", privateEvidenceRoot: "0x" + "b".repeat(64) });
    expect(
      validateAttestationLocally(run, SIGNED_EXEC, {
        evidenceTier: "private",
        privateEvidenceRoot: "0x" + "c".repeat(64)
      }).valid
    ).toBe(false);
  });
});

describe("runRelayerAdjudication", () => {
  const graph = {
    nodes: [{ id: "claim:x", type: "Claim" as const, label: "x", data: {} }],
    edges: [],
    redactionPolicy: "private-by-default" as const,
    canonicalHash: "0x" + "5".repeat(64)
  };

  it("POSTs the graph and returns the verified result", async () => {
    const run = await attestedRun(SIGNED_EXEC);
    let postedUrl = "";
    const fetchImpl = async (url: string, init?: RequestInit) => {
      postedUrl = String(url);
      const body = JSON.parse(String(init?.body));
      expect(body.graph.canonicalHash).toBe(graph.canonicalHash);
      return {
        ok: true,
        status: 200,
        json: async () => ({ verifierRun: run, evidenceBadges: [], signedText: SIGNED_EXEC })
      } as unknown as Response;
    };
    const result = await runRelayerAdjudication({ graph, relayerUrl: "https://relay.example", fetchImpl: fetchImpl as any });
    expect(postedUrl).toBe("https://relay.example/adjudicate");
    expect(result.verifierRun.provider).toBe("0g-compute");
    expect((result as { signedText?: string }).signedText).toBeUndefined(); // transient top-level copy removed
    // signedText is now PERSISTED onto the attestation so consumers can re-verify the digest binding.
    expect(result.verifierRun.attestation?.signedText).toBe(SIGNED_EXEC);
    // And the persisted material re-validates against the persisted digest (consumer re-verify path).
    expect(
      validateAttestationLocally(result.verifierRun, result.verifierRun.attestation!.signedText!).valid
    ).toBe(true);
  });

  it("throws when the relayer returns an attestation that fails local validation", async () => {
    const run = await attestedRun(SIGNED_EXEC, { signingAddress: "0x" + "0".repeat(40) } as any);
    const fetchImpl = async () =>
      ({ ok: true, status: 200, json: async () => ({ verifierRun: run, evidenceBadges: [], signedText: SIGNED_EXEC }) }) as unknown as Response;
    await expect(
      runRelayerAdjudication({ graph, relayerUrl: "https://relay.example", fetchImpl: fetchImpl as any })
    ).rejects.toThrow(/attestation|signature|local|verdict/i);
  });

  it("forwards evidenceTier and privatePacket in the POST body when provided", async () => {
    const run = await attestedRun(SIGNED_EXEC, {}, {
      evidenceTier: "private",
      privateEvidenceRoot: "0x" + "e".repeat(64),
      verdicts: []
    });
    let postedBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ verifierRun: run, evidenceBadges: [], signedText: SIGNED_EXEC })
      } as unknown as Response;
    };
    const fakePacket = { schemaVersion: "vibetrace.private-packet.v1", evidenceRoot: "0xabc" };
    await runRelayerAdjudication({
      graph,
      relayerUrl: "https://relay.example",
      fetchImpl: fetchImpl as any,
      evidenceTier: "private",
      privateEvidenceRoot: "0x" + "e".repeat(64),
      privatePacket: fakePacket
    });
    expect(postedBody.evidenceTier).toBe("private");
    expect(postedBody.privateEvidenceRoot).toBe("0x" + "e".repeat(64));
    expect(postedBody.privatePacket).toEqual(fakePacket);
  });

  it("ignores relayer-supplied public badges and recomputes them locally (a hostile 'verified' badge with no support edge stays unsupported)", async () => {
    const run = await attestedRun(SIGNED_EXEC);
    // Relayer returns a VALID attestation but injects a badge marking claim:x verified, even though
    // the client's graph (claim:x, NO edges) has no `supports` edge for it.
    const hostileBadge = {
      claimId: "claim:x",
      status: "verified" as const,
      confidence: 0.9,
      supportingNodes: [],
      publicExplanation: "trust me",
      provenance: "structural-only" as const
    };
    const fetchImpl = async () =>
      ({ ok: true, status: 200, json: async () => ({ verifierRun: run, evidenceBadges: [hostileBadge], signedText: SIGNED_EXEC }) }) as unknown as Response;
    const result = await runRelayerAdjudication({ graph, relayerUrl: "https://relay.example", fetchImpl: fetchImpl as any });
    const x = result.evidenceBadges.find((b) => b.claimId === "claim:x");
    // The injected "verified" is discarded; the badge is recomputed from the client's edge-less graph.
    expect(x?.status).toBe("unsupported");
    expect(x?.confidence).toBe(0);
  });

  it("downgrades a relayer's no-support 'substantiated' VERDICT to 'unsupported' client-side (viewer headline gate)", async () => {
    // Hostile relayer: a self-consistent run whose verdict WORD says substantiated for claim:x, which has
    // NO support edge in the client's graph. The viewer/registry headline reads run.verdicts, so the client
    // must downgrade the WORD too — not just the badge.
    const noSupportVerdict: ClaimVerdict[] = [{
      claimId: "claim:x", verdict: "substantiated", confidence: 0.9, supportingNodes: [],
      rationale: "trust me", abstainReason: null,
      dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
    }];
    const run = await attestedRun(SIGNED_EXEC, {}, { verdicts: noSupportVerdict });
    const fetchImpl = async () =>
      ({ ok: true, status: 200, json: async () => ({ verifierRun: run, evidenceBadges: [], signedText: SIGNED_EXEC }) }) as unknown as Response;
    const result = await runRelayerAdjudication({ graph, relayerUrl: "https://relay.example", fetchImpl: fetchImpl as any });
    const v = result.verifierRun.verdicts?.find((x) => x.claimId === "claim:x");
    expect(v?.verdict).toBe("unsupported"); // the verdict WORD is gated client-side, not just the badge
    expect(result.verifierRun.verdictRoot).toBe(canonicalHash(result.verifierRun.verdicts));
    expect(result.evidenceBadges.find((b) => b.claimId === "claim:x")?.status).toBe("unsupported");
  });

  it("tier-aware: does NOT apply the public-support downgrade on the PRIVATE path", async () => {
    // On the private path a verdict is legitimately substantiated by packet evidence with no public
    // support edge. runRelayerAdjudication MUST NOT run downgradeUnsupportedVerdicts — the authoritative
    // private gate is the CLI's upgradeVerdictsWithPacket + packetCoversClaim. The verdict word survives
    // here; the CLI later gates it against the packet.
    const privateVerdict: ClaimVerdict[] = [{
      claimId: "claim:x", verdict: "substantiated", confidence: 0.8, supportingNodes: ["file:src/x.ts"],
      rationale: "private excerpt", abstainReason: null,
      dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
    }];
    const run = await attestedRun(SIGNED_EXEC, {}, {
      evidenceTier: "private",
      privateEvidenceRoot: "0x" + "e".repeat(64),
      verdicts: privateVerdict
    });
    const fetchImpl = async () =>
      ({ ok: true, status: 200, json: async () => ({ verifierRun: run, evidenceBadges: [], signedText: SIGNED_EXEC }) }) as unknown as Response;
    const result = await runRelayerAdjudication({
      graph,
      relayerUrl: "https://relay.example",
      fetchImpl: fetchImpl as any,
      evidenceTier: "private",
      privateEvidenceRoot: "0x" + "e".repeat(64)
    });
    const v = result.verifierRun.verdicts?.find((x) => x.claimId === "claim:x");
    expect(v?.verdict).toBe("substantiated"); // NOT downgraded — private path defers to the CLI packet gate
    expect(v?.confidence).toBe(0.8);
  });
});
