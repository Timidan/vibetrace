import { describe, expect, it } from "vitest";
import { Wallet, hashMessage } from "ethers";
import { canonicalHash } from "@vibetrace/schema";
import { runLocalVerifier, runVibeTraceVerifier } from "./index";

describe("local verifier", () => {
  it("creates evidence badges without exposing raw prompt content", async () => {
    const result = await runLocalVerifier({
      graph: {
        nodes: [
          {
            id: "claim:storage",
            type: "Claim",
            label: "Uses 0G Storage",
            data: { text: "Uses 0G Storage" }
          },
          {
            id: "file:src/storage.ts@abc123",
            type: "FileVersion",
            label: "src/storage.ts",
            data: { path: "src/storage.ts", hash: "0x" + "1".repeat(64) }
          }
        ],
        edges: [
          {
            id: "edge-1",
            from: "file:src/storage.ts@abc123",
            to: "claim:storage",
            type: "supports"
          }
        ],
        redactionPolicy: "private-by-default",
        canonicalHash: "0x" + "2".repeat(64)
      },
      now: () => "2026-06-17T10:00:00.000Z"
    });

    expect(result.evidenceBadges).toEqual([
      expect.objectContaining({
        claimId: "claim:storage",
        status: "verified",
        confidence: 0.9
      })
    ]);
    expect(result.verifierRun.summary).not.toMatch(/prompt/i);
  });

  it("emits structural-only provenance and file-only supportingNodes via the merge", async () => {
    const result = await runLocalVerifier({
      graph: {
        nodes: [
          { id: "claim:storage", type: "Claim", label: "Uses 0G Storage", data: {} },
          {
            id: "file:src/storage.ts@abc123",
            type: "FileVersion",
            label: "src/storage.ts",
            data: { path: "src/storage.ts", hash: "0x" + "1".repeat(64) }
          },
          { id: "trace:s1", type: "TraceSpan", label: "span", data: {} }
        ],
        edges: [
          { id: "edge-1", from: "file:src/storage.ts@abc123", to: "claim:storage", type: "supports" },
          { id: "edge-2", from: "trace:s1", to: "claim:storage", type: "supports" }
        ],
        redactionPolicy: "private-by-default",
        canonicalHash: "0x" + "2".repeat(64)
      },
      now: () => "2026-06-17T10:00:00.000Z"
    });

    const badge = result.evidenceBadges[0];
    expect(badge.status).toBe("verified");
    expect(badge.provenance).toBe("structural-only");
    expect(badge.verdict).toBeUndefined();
    // span supports edge must not leak into the badge's supportingNodes.
    expect(badge.supportingNodes).toEqual(["file:src/storage.ts@abc123"]);
  });
});

describe("runVibeTraceVerifier dispatch", () => {
  const enclave = new Wallet("0x" + "3".repeat(64));
  const graph = {
    nodes: [
      { id: "claim:storage", type: "Claim" as const, label: "Uses 0G Storage", data: {} },
      { id: "file:src/storage.ts@abc", type: "FileVersion" as const, label: "src/storage.ts", data: {} }
    ],
    edges: [{ id: "e1", from: "file:src/storage.ts@abc", to: "claim:storage", type: "supports" as const }],
    redactionPolicy: "private-by-default" as const,
    canonicalHash: "0x" + "5".repeat(64)
  };

  const adj = JSON.stringify({
    schema: "vibetrace.adjudication.v1",
    graphHash: graph.canonicalHash,
    evidenceTier: "public-only",
    claims: [
      {
        claimId: "claim:storage",
        verdict: "substantiated",
        confidence: 0.8,
        supportingNodes: ["file:src/storage.ts@abc"],
        rationale: "storage.ts integrates 0G Storage",
        abstainReason: null,
        dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
      }
    ],
    abstained: []
  });

  function brokerFetch() {
    return async (url: string) => {
      if (String(url).includes("/signature/")) {
        const signature = await enclave.signMessage(adj);
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: adj, signature }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "zg-res-key" ? "ck" : null) },
        json: async () => ({ id: "c", choices: [{ message: { content: adj } }], usage: {} })
      } as unknown as Response;
    };
  }

  const broker = {
    inference: {
      listServiceWithDetail: async () => [
        { provider: "0xGood", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: enclave.address, model: "m" }
      ],
      getServiceMetadata: async () => ({ endpoint: "https://e/v1", model: "m" }),
      getRequestHeaders: async () => ({ Authorization: "Bearer t" }),
      processResponse: async () => true,
      verifyService: async () => ({ composeVerification: { passed: true }, signerVerification: { allMatch: true }, reportsData: { combined: {} } }),
      getSignerRaDownloadLink: async () => "ra",
      getChatSignatureDownloadLink: async (_p: string, chatID: string) => `https://e/v1/proxy/signature/${chatID}`
    }
  };

  it("falls back to structural-only local verifier when no broker/relayer is supplied", async () => {
    const result = await runVibeTraceVerifier({ graph, env: {}, now: () => "2026-06-19T00:00:00.000Z" });
    expect(result.verifierRun.provider).toBe("0g-dev");
    expect(result.verifierRun.attestation).toBeUndefined();
  });

  it("routes through the attested adjudicator when a broker is supplied (relayer server path)", async () => {
    const result = await runVibeTraceVerifier({
      graph,
      env: {},
      broker: broker as any,
      quoteStorage: { uploadJson: async () => ({ rootHash: "0x" + "c".repeat(64), uri: "0g://x" }) },
      fetchImpl: brokerFetch() as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    expect(result.verifierRun.provider).toBe("0g-compute");
    expect(result.verifierRun.attestation?.processResponseValid).toBe(true);
    expect(result.verifierRun.verdictRoot).toBeDefined();
  });

  it("routes through the relayer client when only a relayerUrl is supplied (CLI path)", async () => {
    // The relayer returns an already-attested run WITH signedText; the client re-validates it locally.
    // signedText is the `responseHash:chatID` (the EXECUTION material the enclave put its signature
    // over), NOT the verdict JSON. Verdicts come from the response content; verdictRoot hashes them.
    const { parseAdjudicationV1 } = await import("./adjudication-schema");
    const parsed = parseAdjudicationV1(JSON.parse(adj));
    const signedExec = `0x${"9".repeat(64)}:chat-abc`;
    const signature = await enclave.signMessage(signedExec);
    const relayerRun = {
      verifierId: "vibetrace-attested-adjudicator",
      provider: "0g-compute",
      model: "m",
      requestHash: "0x" + "1".repeat(64),
      responseHash: "0x" + "1".repeat(64),
      outputHash: "0x" + "1".repeat(64),
      createdAt: "2026-06-19T00:00:00.000Z",
      summary: "judged",
      evidenceTier: "public-only",
      verdicts: parsed.claims,
      verdictRoot: canonicalHash(parsed.claims),
      attestation: {
        scheme: "0g-teeml",
        attests: "tee-execution",
        providerAddress: "0xGood",
        signingAddress: enclave.address,
        signature,
        signedDigest: hashMessage(signedExec),
        responseTextHash: canonicalHash(signedExec),
        processResponseValid: true,
        verifiedAt: "2026-06-19T00:00:00.000Z",
        verifiedBy: "vibetrace-relayer"
      }
    };
    const relayerFetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ verifierRun: relayerRun, evidenceBadges: [], signedText: signedExec }) }) as unknown as Response;
    const result = await runVibeTraceVerifier({
      graph,
      env: { VIBETRACE_RELAYER_URL: "https://relay.example" },
      fetchImpl: relayerFetch as any,
      now: () => "2026-06-19T00:00:00.000Z"
    });
    expect(result.verifierRun.provider).toBe("0g-compute");
    expect(result.verifierRun.attestation?.signingAddress).toBe(enclave.address);
  });
});
