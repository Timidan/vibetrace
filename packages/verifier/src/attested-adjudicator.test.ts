import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactGraph } from "@vibetrace/schema";
import { canonicalHash } from "@vibetrace/schema";
import { buildAdjudicationRequest, crossCheckAdjudication, mapSupportingIndicesToIds, dropTruncatedNegativesOnCap, adjudicationTableCap } from "./attested-adjudicator";
import type { AdjudicationV1 } from "./adjudication-schema";

const graph: ArtifactGraph = {
  nodes: [
    { id: "claim:oauth", type: "Claim", label: "OAuth", data: { text: "Added OAuth login" } },
    { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: { path: "auth/oauth.ts" } }
  ],
  edges: [{ id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" }],
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "7".repeat(64)
};

describe("buildAdjudicationRequest", () => {
  it("pins temperature 0 and json_object output", () => {
    const { body } = buildAdjudicationRequest(graph, "test-model");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("test-model");
  });

  it("embeds the graphHash and never leaks excerpt fields", () => {
    const { body } = buildAdjudicationRequest(graph, "test-model");
    const userMsg = body.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain(graph.canonicalHash);
    expect(userMsg.content).not.toMatch(/promptExcerpt|responseExcerpt/);
  });

  it("derives a deterministic requestHash over model+graph", () => {
    const a = buildAdjudicationRequest(graph, "test-model");
    const expected = canonicalHash({
      model: "test-model",
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges
    });
    expect(a.requestHash).toBe(expected);
  });

  it("hands the model a NUMBERED supportingNodeTable per claim (index-citation), never raw allowed ids", () => {
    const { body } = buildAdjudicationRequest(graph, "test-model");
    const userMsg = body.messages.find((m) => m.role === "user")!;
    const payload = JSON.parse(userMsg.content) as {
      claims: Array<{ claimId: string; supportingNodeTable: Array<{ index: number; ref: string }> }>;
    };
    const oauth = payload.claims.find((c) => c.claimId === "claim:oauth")!;
    expect(oauth.supportingNodeTable).toEqual([{ index: 0, ref: "auth/oauth.ts" }]);
    // The raw id must NOT be handed to the model as a citable token — it cites the index instead.
    expect(userMsg.content).not.toContain("allowedSupportingNodes");
    expect(userMsg.content).toContain("supportingNodeIndices");
  });
});

describe("buildAdjudicationRequest — private packet", () => {
  it("embeds privateEvidence.leaves in the user message when a packet is present", () => {
    const packet = {
      leaves: [{ kind: "diff" as const, id: "diff:src/auth.ts", content: "PLANTED_PRIVATE_DIFF_LEAF_xyz" }],
      evidenceRoot: "0x" + "e".repeat(64)
    };
    const { body, requestHash } = buildAdjudicationRequest(graph, "test-model", packet);
    const userMsg = body.messages.find((m) => m.role === "user")!;
    // The planted leaf content must appear in the user-message payload
    expect(userMsg.content).toContain("PLANTED_PRIVATE_DIFF_LEAF_xyz");
    // The evidenceRoot must also be present
    expect(userMsg.content).toContain("0x" + "e".repeat(64));
    // The requestHash must be different from the public-only hash (it binds over private evidence)
    const { requestHash: publicHash } = buildAdjudicationRequest(graph, "test-model");
    expect(requestHash).not.toBe(publicHash);
  });

  it("uses the PRIVATE system prompt (instructs evidenceTier private) when a packet is present", () => {
    const packet = {
      leaves: [{ kind: "file-excerpt" as const, id: "file:src/auth.ts", content: "private content" }],
      evidenceRoot: "0x" + "e".repeat(64)
    };
    const { body } = buildAdjudicationRequest(graph, "test-model", packet);
    const systemMsg = body.messages.find((m) => m.role === "system")!;
    // The private system prompt instructs the enclave to set evidenceTier to "private"
    expect(systemMsg.content).toContain('"private"');
    // The public system prompt instructs "public-only" — these must differ
    const { body: publicBody } = buildAdjudicationRequest(graph, "test-model");
    const publicSystem = publicBody.messages.find((m) => m.role === "system")!;
    expect(systemMsg.content).not.toBe(publicSystem.content);
  });

  it("public-only path is unchanged when no packet is provided", () => {
    const { body, requestHash } = buildAdjudicationRequest(graph, "test-model");
    const userMsg = body.messages.find((m) => m.role === "user")!;
    // No privateEvidence key in the public-only payload
    expect(userMsg.content).not.toContain("privateEvidence");
    const expected = canonicalHash({
      model: "test-model",
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges
    });
    expect(requestHash).toBe(expected);
  });
});

const xGraph: ArtifactGraph = {
  nodes: [
    { id: "claim:oauth", type: "Claim", label: "OAuth", data: {} },
    { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: {} },
    { id: "trace:s1", type: "TraceSpan", label: "span", data: {} }
  ],
  edges: [
    { id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" },
    { id: "e2", from: "trace:s1", to: "claim:oauth", type: "supports" }
  ],
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "3".repeat(64)
};

const baseAdj: AdjudicationV1 = {
  schema: "vibetrace.adjudication.v1",
  graphHash: "0x" + "3".repeat(64),
  evidenceTier: "public-only",
  claims: [
    {
      claimId: "claim:oauth",
      verdict: "substantiated",
      confidence: 0.9,
      supportingNodes: ["file:auth/oauth.ts@abc"],
      rationale: "oauth.ts implements it",
      abstainReason: null,
      dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
    }
  ],
  abstained: []
};

describe("crossCheckAdjudication", () => {
  it("passes a clean adjudication", () => {
    const r = crossCheckAdjudication(baseAdj, xGraph);
    expect(r.graphHashMatches).toBe(true);
    expect(r.citedUnknownNode).toBe(false);
    expect(r.verdicts[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc"]);
  });

  it("flags graphHash mismatch", () => {
    const r = crossCheckAdjudication({ ...baseAdj, graphHash: "0x" + "9".repeat(64) }, xGraph);
    expect(r.graphHashMatches).toBe(false);
  });

  it("keeps a trace: supporter in the verdict (display/audit), since it is in the neighborhood", () => {
    const adj: AdjudicationV1 = {
      ...baseAdj,
      claims: [{ ...baseAdj.claims[0], supportingNodes: ["file:auth/oauth.ts@abc", "trace:s1"] }]
    };
    const r = crossCheckAdjudication(adj, xGraph);
    expect(r.citedUnknownNode).toBe(false);
    expect(r.verdicts[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc", "trace:s1"]);
  });

  it("records citedUnknownNode for an out-of-neighborhood supporting node but returns verdict verbatim", () => {
    const adj: AdjudicationV1 = {
      ...baseAdj,
      claims: [{ ...baseAdj.claims[0], supportingNodes: ["file:auth/oauth.ts@abc", "file:fake.ts@zzz"] }]
    };
    const r = crossCheckAdjudication(adj, xGraph);
    expect(r.citedUnknownNode).toBe(true);
    // Verdicts are returned VERBATIM here (the enclave attests EXECUTION, not the verdict content).
    // The CALLER is responsible for rejecting on citedUnknownNode.
    expect(r.verdicts[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc", "file:fake.ts@zzz"]);
  });

  it("flags citedUnknownNode for a verdict whose claimId is NOT a Claim node (even with empty supportingNodes)", () => {
    const adj: AdjudicationV1 = {
      ...baseAdj,
      claims: [{ ...baseAdj.claims[0], claimId: "claim:ghost", supportingNodes: [] }]
    };
    const r = crossCheckAdjudication(adj, xGraph);
    expect(r.citedUnknownNode).toBe(true);
  });

  it("tier-aware: a PRIVATE run citing a packet evidence-leaf id is NOT flagged as unknown", () => {
    // The private prompt allows citing privateEvidence.leaves ids. The packet's file-excerpt leaf
    // "file:src/secret.ts" has NO public supports edge in xGraph, so PUBLIC-only crossCheck would
    // reject it — but with the packet passed in it must be accepted as a valid supporting node.
    const adj: AdjudicationV1 = {
      ...baseAdj,
      claims: [{ ...baseAdj.claims[0], supportingNodes: ["file:src/secret.ts"] }]
    };
    const packet = {
      leaves: [{ kind: "file-excerpt", id: "file:src/secret.ts", content: "secret oauth impl" }]
    };
    // PUBLIC-only (no packet): rejected.
    expect(crossCheckAdjudication(adj, xGraph).citedUnknownNode).toBe(true);
    // PRIVATE (packet present): accepted as a valid supporting node.
    expect(crossCheckAdjudication(adj, xGraph, packet).citedUnknownNode).toBe(false);
  });

  it("tier-aware: a PRIVATE run citing a COMMITMENT leaf (claim-list) is still flagged unknown", () => {
    // Only evidence-bearing leaves (file-excerpt/diff/test-output) are valid supporting nodes;
    // a hostile relayer citing the metadata `claim-list` leaf must NOT pass.
    const adj: AdjudicationV1 = {
      ...baseAdj,
      claims: [{ ...baseAdj.claims[0], supportingNodes: ["claim-list"] }]
    };
    const packet = {
      leaves: [{ kind: "claim-list", id: "claim-list", content: "[\"claim:oauth\"]" }]
    };
    expect(crossCheckAdjudication(adj, xGraph, packet).citedUnknownNode).toBe(true);
  });
});

describe("mapSupportingIndicesToIds (index-citation decode)", () => {
  // xGraph: claim:oauth ordered supporters = ["file:auth/oauth.ts@abc", "trace:s1"] (file before trace).
  const echo = (claim: Record<string, unknown>) => ({
    schema: "vibetrace.adjudication.v1",
    graphHash: xGraph.canonicalHash,
    evidenceTier: "public-only",
    claims: [{ claimId: "claim:oauth", verdict: "substantiated", confidence: 0.9, supportingNodes: [], rationale: "x", abstainReason: null, dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }, ...claim }],
    abstained: []
  });

  it("maps integer indices back to the deterministically-ordered ids", () => {
    const out = mapSupportingIndicesToIds(echo({ supportingNodeIndices: [0, 1] }), xGraph) as { claims: Array<Record<string, unknown>> };
    expect(out.claims[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc", "trace:s1"]);
    expect(out.claims[0]).not.toHaveProperty("supportingNodeIndices"); // dropped so strict schema parses
  });

  it("DROPS out-of-range and non-integer indices instead of producing phantom ids (the honesty win)", () => {
    const out = mapSupportingIndicesToIds(echo({ supportingNodeIndices: [0, 99, -1, 1.5, "x"] }), xGraph) as { claims: Array<Record<string, unknown>> };
    expect(out.claims[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc"]); // only the valid index 0 survives
  });

  it("dedupes repeated indices", () => {
    const out = mapSupportingIndicesToIds(echo({ supportingNodeIndices: [0, 0, 0] }), xGraph) as { claims: Array<Record<string, unknown>> };
    expect(out.claims[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc"]);
  });

  it("INDEX-ONLY: ignores model-supplied raw supportingNodes (a weak model can't reach the guard with a phantom id)", () => {
    // Model emits a valid index AND a raw (here in-neighborhood) id; only the index is honored.
    const out = mapSupportingIndicesToIds(echo({ supportingNodes: ["file:phantom@deadbeef"], supportingNodeIndices: [0] }), xGraph) as { claims: Array<Record<string, unknown>> };
    expect(out.claims[0].supportingNodes).toEqual(["file:auth/oauth.ts@abc"]); // from index 0, NOT the raw id
  });

  it("FAIL CLOSED: a positive verdict that cited no valid index is downgraded to unsupported + rejoins abstained", () => {
    const out = mapSupportingIndicesToIds(echo({ verdict: "substantiated", supportingNodes: ["file:auth/oauth.ts@abc"] }), xGraph) as { claims: Array<Record<string, unknown>>; abstained: string[] };
    expect(out.claims[0].supportingNodes).toEqual([]); // raw id dropped, no index cited
    expect(out.claims[0].verdict).toBe("unsupported");
    expect(out.claims[0].confidence).toBe(0);
    expect(out.claims[0].abstainReason).toBe("insufficient-public-evidence");
    expect(out.abstained).toContain("claim:oauth");
  });

  it("leaves an already-unsupported echo untouched (verdict stays unsupported, no spurious change)", () => {
    const out = mapSupportingIndicesToIds(echo({ verdict: "unsupported", confidence: 0, supportingNodes: [] }), xGraph) as { claims: Array<Record<string, unknown>> };
    expect(out.claims[0].verdict).toBe("unsupported");
    expect(out.claims[0].supportingNodes).toEqual([]);
  });

  it("decoded output then SURVIVES crossCheckAdjudication — mapped ids are in-neighborhood by construction", () => {
    const decoded = mapSupportingIndicesToIds(echo({ supportingNodeIndices: [0, 99] }), xGraph);
    const adj = decoded as AdjudicationV1;
    expect(crossCheckAdjudication(adj, xGraph).citedUnknownNode).toBe(false);
  });
});

const bigGraph = (n: number): ArtifactGraph => ({
  nodes: [
    { id: "claim:big", type: "Claim", label: "Big", data: {} },
    ...Array.from({ length: n }, (_, i) => ({ id: `file:f${i}.ts@a`, type: "FileVersion" as const, label: `f${i}.ts`, data: {} }))
  ],
  edges: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: `file:f${i}.ts@a`, to: "claim:big", type: "supports" as const })),
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "5".repeat(64)
});

describe("adjudication table cap (rate-limit fit + truncation honesty)", () => {
  const orig = process.env.VIBETRACE_ADJUDICATION_TABLE_CAP;
  afterEach(() => {
    if (orig === undefined) delete process.env.VIBETRACE_ADJUDICATION_TABLE_CAP;
    else process.env.VIBETRACE_ADJUDICATION_TABLE_CAP = orig;
  });
  const mk = (verdict: string): AdjudicationV1["claims"][number] => ({
    claimId: "claim:big", verdict: verdict as AdjudicationV1["claims"][number]["verdict"], confidence: 0.5,
    supportingNodes: [], rationale: "x", abstainReason: null,
    dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
  });

  it("defaults to 64 and respects the env override", () => {
    delete process.env.VIBETRACE_ADJUDICATION_TABLE_CAP;
    expect(adjudicationTableCap()).toBe(64);
    process.env.VIBETRACE_ADJUDICATION_TABLE_CAP = "10";
    expect(adjudicationTableCap()).toBe(10);
  });

  it("caps the per-claim supportingNodeTable to the top-N so the request fits the provider rate limit", () => {
    process.env.VIBETRACE_ADJUDICATION_TABLE_CAP = "3";
    const { body } = buildAdjudicationRequest(bigGraph(20), "m");
    const payload = JSON.parse(body.messages.find((m) => m.role === "user")!.content) as { claims: Array<{ claimId: string; supportingNodeTable: Array<{ index: number }> }> };
    const big = payload.claims.find((c) => c.claimId === "claim:big")!;
    expect(big.supportingNodeTable.length).toBe(3);
    expect(big.supportingNodeTable.map((r) => r.index)).toEqual([0, 1, 2]); // top-N prefix, deterministic
  });

  it("drops a TRUNCATED claim's NEGATIVE verdict (untrustworthy on partial evidence) but keeps substantiated", () => {
    process.env.VIBETRACE_ADJUDICATION_TABLE_CAP = "3";
    const g = bigGraph(20); // 20 supporters > cap 3 → truncated
    expect(dropTruncatedNegativesOnCap(g, [mk("unsupported")])).toEqual([]); // dropped → structural-only floor
    expect(dropTruncatedNegativesOnCap(g, [mk("inflated")])).toEqual([]); // dropped (oversold needs full view)
    expect(dropTruncatedNegativesOnCap(g, [mk("substantiated")]).length).toBe(1); // KEPT — cites a shown id
  });

  it("leaves a FULLY-SHOWN claim's negative verdict intact (it WAS fully reviewed)", () => {
    process.env.VIBETRACE_ADJUDICATION_TABLE_CAP = "50";
    const g = bigGraph(5); // 5 supporters <= cap 50 → not truncated
    expect(dropTruncatedNegativesOnCap(g, [mk("unsupported")]).length).toBe(1);
  });
});

import { hashMessage } from "ethers";
import { buildTeeAttestation } from "./attested-adjudicator";
import { selectTeeMlProvider, NoTeeMlProviderError } from "./attested-adjudicator";

describe("buildTeeAttestation", () => {
  const signedText = "{\"schema\":\"vibetrace.adjudication.v1\"}";

  it("persists distinct SHA-256 responseTextHash and keccak signedDigest", () => {
    const att = buildTeeAttestation({
      providerAddress: "0xProvider",
      signingAddress: "0xSigner",
      signature: "0xsig",
      signedText,
      processResponseValid: true,
      verifiedBy: "vibetrace-relayer",
      verifiedAt: "2026-06-19T00:00:00.000Z"
    });
    expect(att.signedDigest).toBe(hashMessage(signedText));
    expect(att.responseTextHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(att.responseTextHash).not.toBe(att.signedDigest);
    expect(att.scheme).toBe("0g-teeml");
    expect(att.processResponseValid).toBe(true);
    expect(att.signature).toBe("0xsig");
  });

  it("carries the verifyService summary fields when present", () => {
    const att = buildTeeAttestation({
      providerAddress: "0xProvider",
      signingAddress: "0xSigner",
      signature: "0xsig",
      signedText,
      processResponseValid: true,
      verifySummary: { composeVerificationPassed: true, signerAllMatch: true, teeType: "TDX" },
      quoteHash: "0x" + "b".repeat(64),
      attestationQuoteUri: "0g://" + "b".repeat(64),
      verifiedBy: "vibetrace-relayer",
      verifiedAt: "2026-06-19T00:00:00.000Z"
    });
    expect(att.composeVerificationPassed).toBe(true);
    expect(att.signerAllMatch).toBe(true);
    expect(att.teeType).toBe("TDX");
    expect(att.quoteHash).toBe("0x" + "b".repeat(64));
  });
});

describe("selectTeeMlProvider", () => {
  const services = [
    { provider: "0xOpML", verifiability: "OpML", teeSignerAcknowledged: true, teeSignerAddress: "0xa", model: "m" },
    { provider: "0xUnack", verifiability: "TeeML", teeSignerAcknowledged: false, teeSignerAddress: "0xb", model: "m" },
    { provider: "0xGood", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: "0xc", model: "m" }
  ];

  it("picks the acknowledged TeeML provider", () => {
    expect(selectTeeMlProvider(services).provider).toBe("0xGood");
  });

  it("honors a preferred provider when it is acknowledged TeeML", () => {
    const more = [...services, { provider: "0xPref", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: "0xd", model: "m" }];
    expect(selectTeeMlProvider(more, "0xPref").provider).toBe("0xPref");
  });

  it("throws when no acknowledged TeeML provider exists", () => {
    expect(() => selectTeeMlProvider([services[0], services[1]])).toThrow(NoTeeMlProviderError);
  });
});

import { NoTeeMlProviderError as NoProviderErr } from "./attested-adjudicator";

describe("runAttestedAdjudicator honest degradation", () => {
  const g: ArtifactGraph = {
    nodes: [{ id: "claim:x", type: "Claim", label: "x", data: {} }],
    edges: [],
    redactionPolicy: "private-by-default",
    canonicalHash: "0x" + "6".repeat(64)
  };
  const storage2 = { uploadJson: async () => ({ rootHash: "0x" + "c".repeat(64), uri: "0g://x" }) };

  it("throws NoTeeMlProviderError when discovery yields no acknowledged TeeML", async () => {
    const broker = {
      inference: {
        listServiceWithDetail: async () => [
          { provider: "0xOpML", verifiability: "OpML", teeSignerAcknowledged: true, teeSignerAddress: "0xa", model: "m" }
        ],
        getServiceMetadata: async () => ({ endpoint: "https://e/v1", model: "m" }),
        getRequestHeaders: async () => ({ Authorization: "Bearer t" }),
        processResponse: async () => true,
        verifyService: async () => null,
        getSignerRaDownloadLink: async () => "ra",
        getChatSignatureDownloadLink: async () => "sig"
      }
    };
    await expect(
      runAttestedAdjudicator({
        graph: g,
        broker: broker as any,
        quoteStorage: storage2,
        fetchImpl: (async () => ({}) as any) as any,
        verifiedBy: "r",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toBeInstanceOf(NoProviderErr);
  });

  it("throws on schema-invalid enclave output (forces structural-only upstream)", async () => {
    const broker = {
      inference: {
        listServiceWithDetail: async () => [
          { provider: "0xGood", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: "0xS", model: "m" }
        ],
        getServiceMetadata: async () => ({ endpoint: "https://e/v1", model: "m" }),
        getRequestHeaders: async () => ({ Authorization: "Bearer t" }),
        processResponse: async () => true,
        verifyService: async () => null,
        getSignerRaDownloadLink: async () => "ra",
        getChatSignatureDownloadLink: async (_p: string, chatID: string) => `https://e/v1/proxy/signature/${chatID}`
      }
    };
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => "ck" },
        json: async () => ({ id: "c", choices: [{ message: { content: "{\"not\":\"adjudication\"}" } }], usage: {} })
      }) as unknown as Response;
    await expect(
      runAttestedAdjudicator({
        graph: g,
        broker: broker as any,
        quoteStorage: storage2,
        fetchImpl: fetchImpl as any,
        verifiedBy: "r",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toThrow();
  });
});

import { Wallet, recoverAddress } from "ethers";
import { runAttestedAdjudicator } from "./attested-adjudicator";

// A deterministic enclave signer for the mock. signMessage(text) produces a signature
// that recoverAddress(hashMessage(text), sig) maps back to wallet.address.
const enclave = new Wallet("0x" + "1".repeat(64));

const okGraph: ArtifactGraph = {
  nodes: [
    { id: "claim:oauth", type: "Claim", label: "OAuth", data: {} },
    { id: "file:auth/oauth.ts@abc", type: "FileVersion", label: "auth/oauth.ts", data: {} }
  ],
  edges: [{ id: "e1", from: "file:auth/oauth.ts@abc", to: "claim:oauth", type: "supports" }],
  redactionPolicy: "private-by-default",
  canonicalHash: "0x" + "4".repeat(64)
};

function makeAdjJson(graphHash: string) {
  return JSON.stringify({
    schema: "vibetrace.adjudication.v1",
    graphHash,
    evidenceTier: "public-only",
    claims: [
      {
        claimId: "claim:oauth",
        verdict: "substantiated",
        confidence: 0.9,
        // INDEX-CITATION contract: the model cites an index into its table (0 → file:auth/oauth.ts@abc),
        // leaving supportingNodes []; the producer decodes the index back to the id before parse.
        supportingNodes: [],
        supportingNodeIndices: [0],
        rationale: "oauth.ts implements it",
        abstainReason: null,
        dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
      }
    ],
    abstained: []
  });
}

// PRIVATE-path model response: the private contract cites node/leaf ids DIRECTLY (no numbered table, no
// index decode), so private-path mocks must use raw supportingNodes — not makeAdjJson's public index shape.
function makeAdjJsonRawIds(graphHash: string) {
  return JSON.stringify({
    schema: "vibetrace.adjudication.v1",
    graphHash,
    evidenceTier: "public-only",
    claims: [
      {
        claimId: "claim:oauth",
        verdict: "substantiated",
        confidence: 0.9,
        supportingNodes: ["file:auth/oauth.ts@abc"],
        rationale: "oauth.ts implements it",
        abstainReason: null,
        dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
      }
    ],
    abstained: []
  });
}

// REAL 0G TeeML behavior: the /signature/ endpoint returns { text, signature } where
// text === "<responseHash>:<chatID>" (the enclave attests EXECUTION + a provider-computed
// response hash, NOT the verdict JSON). The verdicts come from the completion `content`.
// signature recovers to the enclave signer. fetchImpl routes by URL: the chat/completions POST
// returns the completion (verdict JSON in content); the /signature/ GET returns { text, signature }.
function signedExecText(header: string) {
  // mimics "9490d04…:670332c…" — a response hash joined to the chatID, NOT the verdicts.
  return `0x${"9".repeat(64)}:${header}`;
}
function makeFetch(adjJson: string, header = "chat-123") {
  return async (url: string) => {
    if (String(url).includes("/signature/")) {
      const text = signedExecText(header);
      const signature = await enclave.signMessage(text);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ text, signature })
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "zg-res-key" ? header : null) },
      json: async () => ({
        id: "completion-xyz",
        choices: [{ message: { content: adjJson } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      })
    } as unknown as Response;
  };
}

function makeBroker(opts?: { processResponse?: boolean | null }) {
  return {
    inference: {
      listServiceWithDetail: async () => [
        { provider: "0xGood", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: enclave.address, model: "llm-x" }
      ],
      getServiceMetadata: async () => ({ endpoint: "https://enclave.example/v1", model: "llm-x" }),
      getRequestHeaders: async () => ({ Authorization: "Bearer tok" }),
      processResponse: async () => (opts?.processResponse ?? true),
      verifyService: async () => ({
        composeVerification: { passed: true },
        signerVerification: { allMatch: true },
        reportsData: { combined: {} }
      }),
      getSignerRaDownloadLink: async () => "https://enclave.example/ra",
      getChatSignatureDownloadLink: async (_p: string, chatID: string) => `https://enclave.example/v1/proxy/signature/${chatID}`
    }
  };
}

const storage = { uploadJson: async () => ({ rootHash: "0x" + "c".repeat(64), uri: "0g://" + "c".repeat(64) }) };

describe("runAttestedAdjudicator", () => {
  it("emits provider 0g-compute with a populated attestation, verdicts, and verdictRoot", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(adj) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    expect(result.verifierRun.provider).toBe("0g-compute");
    expect(result.verifierRun.attestation?.processResponseValid).toBe(true);
    expect(result.verifierRun.attestation?.providerAddress).toBe("0xGood");
    expect(result.verifierRun.attestation?.quoteHash).toBe("0x" + "c".repeat(64));
    // The attestation honestly labels what it proves: TEE EXECUTION, not the verdict content.
    expect(result.verifierRun.attestation?.attests).toBe("tee-execution");
    expect(result.verifierRun.evidenceTier).toBe("public-only");
    // Verdicts come from the completion CONTENT (cross-checked against the graph), NOT the signed text.
    expect(result.verifierRun.verdicts?.[0].verdict).toBe("substantiated");
    // verdictRoot = canonicalHash over the PERSISTED ClaimVerdict[] (run.verdicts), tamper-hygiene only.
    const { canonicalHash } = await import("@vibetrace/schema");
    expect(result.verifierRun.verdictRoot).toBe(canonicalHash(result.verifierRun.verdicts));
    // The signed text the enclave returns is `responseHash:chatID`, NOT the verdict JSON.
    expect(result.signedText).toBe(signedExecText("chat-123"));
    expect(result.signedText).not.toContain("substantiated");
  });

  it("downgrades a no-support 'substantiated' verdict to 'unsupported' BEFORE persisting (honesty gate)", async () => {
    // A graph whose claim has NO file `supports` edge (an external/unanchored claim).
    const noSupportGraph: ArtifactGraph = {
      nodes: [{ id: "claim:oauth", type: "Claim", label: "OAuth", data: {} }],
      edges: [],
      redactionPolicy: "private-by-default",
      canonicalHash: "0x" + "8".repeat(64)
    };
    // The relayer/model asserts "substantiated" anyway (a hostile or over-eager verdict).
    const substantiated = JSON.stringify({
      schema: "vibetrace.adjudication.v1",
      graphHash: noSupportGraph.canonicalHash,
      evidenceTier: "public-only",
      claims: [
        {
          claimId: "claim:oauth",
          verdict: "substantiated",
          confidence: 0.95,
          supportingNodes: [],
          rationale: "trust me, it is built",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        }
      ],
      abstained: []
    });
    const result = await runAttestedAdjudicator({
      graph: noSupportGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(substantiated) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    // PERSISTED verdicts (what the viewer/registry headline reads) must NOT say substantiated.
    const persisted = result.verifierRun.verdicts!.find((v) => v.claimId === "claim:oauth")!;
    expect(persisted.verdict).toBe("unsupported");
    expect(persisted.confidence).toBe(0);
    expect(persisted.abstainReason).toBe("insufficient-public-evidence");
    // verdictRoot is recomputed over the DOWNGRADED verdicts (consistent with run.verdicts).
    const { canonicalHash } = await import("@vibetrace/schema");
    expect(result.verifierRun.verdictRoot).toBe(canonicalHash(result.verifierRun.verdicts));
    // The badge was already unsupported; the verdict word now agrees with it.
    const badge = result.evidenceBadges.find((b) => b.claimId === "claim:oauth");
    expect(badge?.status).toBe("unsupported");
  });

  it("merges an attested inflated verdict into a partial badge (verdict + provenance, file-only support)", async () => {
    const inflated = JSON.stringify({
      schema: "vibetrace.adjudication.v1",
      graphHash: okGraph.canonicalHash,
      evidenceTier: "public-only",
      claims: [
        {
          claimId: "claim:oauth",
          verdict: "inflated",
          confidence: 0.6,
          supportingNodes: [],
          supportingNodeIndices: [0],
          rationale: "claim oversells the single supporting file",
          abstainReason: null,
          dimensions: { relevance: "weak", sufficiency: "thin", contradiction: "none" }
        }
      ],
      abstained: []
    });
    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(inflated) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    const badge = result.evidenceBadges.find((b) => b.claimId === "claim:oauth");
    expect(badge?.status).toBe("partial");
    expect(badge?.verdict).toBe("inflated");
    expect(badge?.provenance).toBe("structural+attested");
    // The badge keeps file-only supporters (the VibeScore gate); never trace: ids from the verdict.
    expect(badge?.supportingNodes).toEqual(["file:auth/oauth.ts@abc"]);
  });

  it("persists the REAL enclave signature over `responseHash:chatID`: recoverAddress(hashMessage(signedText), signature) === signingAddress", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    const { hashMessage } = await import("ethers");
    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(adj) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    const att = result.verifierRun.attestation!;
    const signedText = result.signedText; // the `responseHash:chatID` the enclave actually signed
    // The persisted signature is NOT the Authorization header ("Bearer tok"); it recovers to the signer
    // over the EXECUTION material (responseHash:chatID), proving an acknowledged TEE signer ran inference.
    expect(att.signature).not.toContain("Bearer");
    expect(recoverAddress(hashMessage(signedText), att.signature).toLowerCase()).toBe(att.signingAddress.toLowerCase());
    // responseTextHash is SHA-256 over the SIGNED `responseHash:chatID` (execution material), NOT the verdicts.
    const { canonicalHash } = await import("@vibetrace/schema");
    expect(att.responseTextHash).toBe(canonicalHash(signedText));
    expect(att.signedDigest).toBe(hashMessage(signedText));
  });

  it("rejects the run when the enclave signature does not recover to signingAddress", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    const badFetch = async (url: string) => {
      if (String(url).includes("/signature/")) {
        // Signature over DIFFERENT text → recovers to a different address.
        const signature = await enclave.signMessage("tampered");
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: adj, signature }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "zg-res-key" ? "ck" : null) },
        json: async () => ({ id: "c", choices: [{ message: { content: adj } }], usage: {} })
      } as unknown as Response;
    };
    await expect(
      runAttestedAdjudicator({
        graph: okGraph,
        broker: makeBroker() as any,
        quoteStorage: storage,
        fetchImpl: badFetch as any,
        verifiedBy: "vibetrace-relayer",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toThrow(/signature|recover|signer/i);
  });

  it("rejects the run when the signature endpoint returns no signed text (no fallback to content)", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    const noTextFetch = async (url: string) => {
      if (String(url).includes("/signature/")) {
        // Enclave returns a signature but NO `text` — we must NOT fall back to the completion content.
        const signature = await enclave.signMessage("anything");
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ signature }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "zg-res-key" ? "ck" : null) },
        json: async () => ({ id: "c", choices: [{ message: { content: adj } }], usage: {} })
      } as unknown as Response;
    };
    await expect(
      runAttestedAdjudicator({
        graph: okGraph,
        broker: makeBroker() as any,
        quoteStorage: storage,
        fetchImpl: noTextFetch as any,
        verifiedBy: "vibetrace-relayer",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toThrow(/no signed response text/i);
  });

  it("rejects the run when graphHash echo mismatches", async () => {
    const adj = makeAdjJson("0x" + "0".repeat(64));
    await expect(
      runAttestedAdjudicator({
        graph: okGraph,
        broker: makeBroker() as any,
        quoteStorage: storage,
        fetchImpl: makeFetch(adj) as any,
        verifiedBy: "vibetrace-relayer",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toThrow(/graphHash/i);
  });

  it("treats processResponse=false as not attested (throws)", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    await expect(
      runAttestedAdjudicator({
        graph: okGraph,
        broker: makeBroker({ processResponse: false }) as any,
        quoteStorage: storage,
        fetchImpl: makeFetch(adj) as any,
        verifiedBy: "vibetrace-relayer",
        now: () => "2026-06-19T00:00:00.000Z"
      })
    ).rejects.toThrow(/processResponse|not.*attested/i);
  });

  it("sets evidenceTier='private' and privateEvidenceRoot when options.privatePacket is provided", async () => {
    const adj = makeAdjJsonRawIds(okGraph.canonicalHash);
    const fakePacket = {
      schemaVersion: "vibetrace.private-packet.v1" as const,
      evidenceRoot: "0x" + "f".repeat(64)
    };
    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(adj) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z",
      privatePacket: fakePacket
    });
    expect(result.verifierRun.evidenceTier).toBe("private");
    expect(result.verifierRun.privateEvidenceRoot).toBe("0x" + "f".repeat(64));
  });

  it("keeps evidenceTier='public-only' when no privatePacket is provided", async () => {
    const adj = makeAdjJson(okGraph.canonicalHash);
    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(adj) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z"
    });
    expect(result.verifierRun.evidenceTier).toBe("public-only");
    expect(result.verifierRun.privateEvidenceRoot).toBeUndefined();
  });

  it("private packet: planted leaf content reaches the TEE POST body and run is evidenceTier=private with privateEvidenceRoot set", async () => {
    const PLANTED = "PLANTED_PRIVATE_DIFF_LEAF_xyz";
    const adj = makeAdjJsonRawIds(okGraph.canonicalHash);

    // Capture the body that is POSTed to /chat/completions
    let capturedPostBody: string | undefined;
    const capturingFetch = async (url: string, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) {
        capturedPostBody = typeof init?.body === "string" ? init.body : undefined;
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === "zg-res-key" ? "chat-456" : null) },
          json: async () => ({
            id: "completion-private",
            choices: [{ message: { content: adj } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          })
        } as unknown as Response;
      }
      // /signature/ route — sign with the enclave wallet
      if (String(url).includes("/signature/")) {
        const signature = await enclave.signMessage(adj);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ text: adj, signature })
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const fakePacket = {
      schemaVersion: "vibetrace.private-packet.v1" as const,
      evidenceRoot: "0x" + "f".repeat(64),
      leaves: [
        { kind: "diff" as const, id: "diff:src/auth.ts", content: PLANTED }
      ]
    };

    const result = await runAttestedAdjudicator({
      graph: okGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: capturingFetch as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z",
      privatePacket: fakePacket
    });

    // The planted string MUST be present in the actual POST body sent to the enclave
    expect(capturedPostBody).toBeDefined();
    expect(capturedPostBody!).toContain(PLANTED);

    // The returned run must carry evidenceTier=private and privateEvidenceRoot
    expect(result.verifierRun.evidenceTier).toBe("private");
    expect(result.verifierRun.privateEvidenceRoot).toBe("0x" + "f".repeat(64));
  });

  it("a PRIVATE run with a legitimate file-excerpt leaf citation is NOT downgraded", async () => {
    // Graph claim has NO public file `supports` edge — on the PUBLIC path this would be downgraded to
    // unsupported. But the private packet legitimately substantiates it via a file-excerpt leaf.
    const noPublicSupportGraph: ArtifactGraph = {
      nodes: [{ id: "claim:oauth", type: "Claim", label: "OAuth", data: {} }],
      edges: [],
      redactionPolicy: "private-by-default",
      canonicalHash: "0x" + "7".repeat(64)
    };
    // The private adjudicator cites the packet's evidence leaf id and returns "substantiated".
    const privateAdj = JSON.stringify({
      schema: "vibetrace.adjudication.v1",
      graphHash: noPublicSupportGraph.canonicalHash,
      evidenceTier: "private",
      claims: [
        {
          claimId: "claim:oauth",
          verdict: "substantiated",
          confidence: 0.8,
          supportingNodes: ["file:src/auth.ts"],
          rationale: "private excerpt shows the oauth impl",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        }
      ],
      abstained: []
    });
    const packet = {
      schemaVersion: "vibetrace.private-packet.v1" as const,
      evidenceRoot: "0x" + "f".repeat(64),
      leaves: [{ kind: "file-excerpt" as const, id: "file:src/auth.ts", content: "oauth impl here" }]
    };
    const result = await runAttestedAdjudicator({
      graph: noPublicSupportGraph,
      broker: makeBroker() as any,
      quoteStorage: storage,
      fetchImpl: makeFetch(privateAdj) as any,
      verifiedBy: "vibetrace-relayer",
      now: () => "2026-06-19T00:00:00.000Z",
      privatePacket: packet
    });
    // The verdict word SURVIVES — the public-support downgrade must NOT run on the private path.
    const persisted = result.verifierRun.verdicts!.find((v) => v.claimId === "claim:oauth")!;
    expect(persisted.verdict).toBe("substantiated");
    expect(persisted.confidence).toBe(0.8);
    expect(persisted.abstainReason).toBeNull();
    expect(result.verifierRun.evidenceTier).toBe("private");
  });
});
