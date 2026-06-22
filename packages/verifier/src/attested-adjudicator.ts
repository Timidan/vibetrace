import { mkdir } from "node:fs/promises";
import type { ArtifactGraph, ClaimVerdict, EvidenceBadge, TeeAttestation, VerifierRun } from "@vibetrace/schema";
import { canonicalHash } from "@vibetrace/schema";
import { hashMessage, recoverAddress } from "ethers";
import type { AdjudicationV1 } from "./adjudication-schema";
import { parseAdjudicationV1, extractAdjudicationJson, normalizeAdjudicationEnums } from "./adjudication-schema";
import { buildStructuralNeighborhood, orderedClaimSupporters } from "./structural-support";
import { buildMergedEvidenceBadges, downgradeUnsupportedVerdicts } from "./merge";

export type ChatMessage = { role: "system" | "user"; content: string };

export type AdjudicationRequestBody = {
  model: string;
  temperature: 0;
  response_format: { type: "json_object" };
  messages: ChatMessage[];
};

const SYSTEM_PROMPT = [
  "You are VibeTrace's neutral build adjudicator running inside a TEE.",
  "You receive a public artifact graph: claims, file versions, trace spans, and typed edges.",
  "The graph carries hashes, file paths, ids, and timestamps only — never prompt or response text.",
  "For each Claim node, judge whether its structural support substantiates the claim text along three",
  "dimensions: relevance, sufficiency/proportionality, and contradiction.",
  "Verdicts: substantiated | inflated | unsupported. inflated = real but oversold.",
  "If the public surface is too thin to judge a semantic claim, set verdict=unsupported,",
  "abstainReason=insufficient-public-evidence, confidence=0, and list the claim in abstained.",
  "Each claim carries a numbered supportingNodeTable of its ONLY allowed supporters. To cite support,",
  "set supportingNodeIndices to integer indices FROM THAT claim's table — never ids, never invent numbers.",
  "Leave supportingNodes as []. rationale <=240 chars, reference the table refs, no prompt text.",
  "Echo the input graphHash exactly. Reply with ONLY a JSON object matching schema",
  "vibetrace.adjudication.v1 (keys: schema, graphHash, evidenceTier, claims[], abstained[]).",
  "Set evidenceTier to \"public-only\". No markdown, no commentary."
].join(" ");

const PRIVATE_SYSTEM_PROMPT = [
  "You are VibeTrace's neutral build adjudicator running inside a TEE.",
  "You receive a public artifact graph AND sealed private evidence (diffs, file excerpts, test output).",
  "The graph carries hashes, file paths, ids, and timestamps. Private evidence is in privateEvidence.leaves.",
  "For each Claim node, judge using BOTH the public graph AND the private evidence.",
  "You MAY use private leaf content to substantiate semantic claims that the public graph alone could not.",
  "Verdicts: substantiated | inflated | unsupported. inflated = real but oversold.",
  "If a claim's private evidence substantiates it, set verdict=substantiated.",
  "If the combined evidence is still insufficient, set verdict=unsupported,",
  "abstainReason=insufficient-public-evidence, confidence=0, and list the claim in abstained.",
  "supportingNodes MUST be ids of file:- or trace:-prefixed nodes that support the claim, or leaf ids",
  "from privateEvidence.leaves. Never invent ids. rationale <=240 chars, cite node ids/leaf ids, no raw content.",
  "Echo the input graphHash exactly. Reply with ONLY a JSON object matching schema",
  "vibetrace.adjudication.v1 (keys: schema, graphHash, evidenceTier, claims[], abstained[]).",
  "Set evidenceTier to \"private\". No markdown, no commentary."
].join(" ");

/** Minimal shape of a private-packet leaf as seen by the TEE request builder. */
type PrivateLeaf = { kind: string; id: string; content: string };

/**
 * Per-claim cap on how many candidate supporters are shown to the model (env-tunable). The 0G Compute
 * provider rate-limits the weak model at ~2000 tokens/min; a real self-trace claim can have THOUSANDS of
 * structural supporters (a real self-trace: 1657 on one claim → a ~14k-token request that 429s). Showing only the
 * top `cap` (deterministic prefix of orderedClaimSupporters) keeps a single adjudication request inside
 * the budget. Honesty is preserved by dropTruncatedNegativesOnCap: a truncated claim can only ever be
 * UPGRADED by what the model saw, never confidently negated on evidence it never saw. Default 64.
 */
export function adjudicationTableCap(): number {
  const n = Math.floor(Number(process.env.VIBETRACE_ADJUDICATION_TABLE_CAP ?? "64"));
  return Number.isFinite(n) && n > 0 ? n : 64;
}

export function buildAdjudicationRequest(
  graph: ArtifactGraph,
  model: string,
  privatePacket?: { leaves: PrivateLeaf[]; evidenceRoot: string }
): { body: AdjudicationRequestBody; requestHash: string } {
  if (privatePacket) {
    const privateEvidence = { evidenceRoot: privatePacket.evidenceRoot, leaves: privatePacket.leaves };
    const userPayload = {
      instruction: "Adjudicate every Claim node using the public graph and the private evidence. Output vibetrace.adjudication.v1 JSON only.",
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges,
      privateEvidence
    };
    const body: AdjudicationRequestBody = {
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PRIVATE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    };
    const requestHash = canonicalHash({
      model,
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges,
      privateEvidence
    });
    return { body, requestHash };
  }

  // SKELETON STRATEGY (for weak TEE models): instead of asking the model to GENERATE the strict
  // vibetrace.adjudication.v1 object from scratch (which 7B models fail — they omit fields or emit
  // non-JSON), we hand it a COMPLETE, VALID, all-abstain baseline and ask it to return that object,
  // upgrading only claims the allowed supporting nodes substantiate. The model's failure mode (echo
  // the input) now yields a parseable, signed, HONEST abstention rather than a rejected run.
  const claimNodes = graph.nodes.filter((n) => n.type === "Claim");
  // INDEX-CITATION: hand the model a NUMBERED candidate table per claim and have it cite integer
  // indices (supportingNodeIndices), not raw ids. runAttestedAdjudicator maps the indices back to ids
  // via the SAME deterministic ordering before crossCheckAdjudication — so a weak model literally
  // cannot emit a phantom id (out-of-range indices are dropped), which is exactly what tripped the
  // honesty guard into rejecting the whole run on large graphs. The guard is untouched: mapped ids are
  // always in-neighborhood by construction.
  const ordered = orderedClaimSupporters(graph); // claimId -> DETERMINISTIC ordered supporter ids
  const cap = adjudicationTableCap(); // show only the top-`cap` candidates per claim (rate-limit fit)
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const baseline = {
    schema: "vibetrace.adjudication.v1",
    graphHash: graph.canonicalHash,
    evidenceTier: "public-only",
    claims: claimNodes.map((n) => ({
      claimId: n.id,
      verdict: "unsupported",
      confidence: 0,
      supportingNodes: [] as string[],
      rationale: "Insufficient public evidence to substantiate this claim.",
      abstainReason: "insufficient-public-evidence",
      dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
    })),
    abstained: claimNodes.map((n) => n.id)
  };
  const claimsForModel = claimNodes.map((n) => ({
    claimId: n.id,
    text: (n.data as { text?: string } | undefined)?.text ?? n.label,
    supportingNodeTable: (ordered.get(n.id) ?? []).slice(0, cap).map((id, index) => ({
      index,
      ref: nodeById.get(id)?.label ?? id.replace(/^(file:|trace:)/, "").replace(/@[0-9a-f]+$/i, "")
    }))
  }));
  const userPayload = {
    instruction:
      "`baseline` below is a COMPLETE and VALID vibetrace.adjudication.v1 JSON object (every claim unsupported/abstained). " +
      "Return `baseline` as your ENTIRE JSON response, with ONLY this allowed change: for any claim in `claims` whose " +
      "`supportingNodeTable` entries clearly substantiate its `text`, set that claim's verdict to \"substantiated\" (or \"inflated\" if " +
      "real but oversold), add a `supportingNodeIndices` array holding the integer `index` values of the relevant table entries " +
      "(cite INDICES from that claim's own table — never ids, never numbers not in the table), set confidence in [0,1], write a " +
      "rationale (<=240 chars), set its abstainReason to null, and remove its claimId from `abstained`. Leave supportingNodes as []. " +
      "Leave every other field EXACTLY as in baseline; echo graphHash exactly. Output ONLY the resulting JSON object — no markdown, no commentary.",
    baseline,
    claims: claimsForModel
  };
  const body: AdjudicationRequestBody = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  };
  const requestHash = canonicalHash({
    model,
    graphHash: graph.canonicalHash,
    nodes: graph.nodes,
    edges: graph.edges
  });
  return { body, requestHash };
}

export function crossCheckAdjudication(
  adjudication: AdjudicationV1,
  graph: ArtifactGraph,
  /** PRIVATE-tier only: the evidence-bearing packet leaves whose ids are also valid supporting
   *  nodes. PUBLIC-only requests pass undefined, keeping the strict public-neighbor-only gate. */
  privatePacket?: { leaves: PrivateLeaf[] }
): { graphHashMatches: boolean; verdicts: ClaimVerdict[]; citedUnknownNode: boolean } {
  const graphHashMatches = adjudication.graphHash === graph.canonicalHash;
  // Verdict gate = structural NEIGHBORHOOD (file:+trace:). A ClaimVerdict may cite
  // trace:/file: ids for display/audit; the badge layer (structuralBadgeFloor) is the
  // one that narrows to file-only for the VibeScore gate. This is the deliberate
  // resolution of the verdict-vs-badge contradiction.
  const neighborhood = buildStructuralNeighborhood(graph);
  // TIER-AWARE: on the PRIVATE path the prompt legitimately allows citing evidence-leaf ids
  // (file-excerpt/diff/test-output) from the sealed packet, so those ids are ALSO valid supporting
  // nodes here. PUBLIC-only requests carry no packet and keep the strict public-neighbor-only gate.
  const EVIDENCE_LEAF_KINDS = new Set(["file-excerpt", "diff", "test-output"]);
  const privateLeafIds = new Set(
    (privatePacket?.leaves ?? []).filter((l) => EVIDENCE_LEAF_KINDS.has(l.kind)).map((l) => l.id)
  );
  // Real public Claim node ids — a verdict for an UNKNOWN claimId is rejected (otherwise a hostile/buggy
  // response could inject an arbitrary claimId, e.g. with empty supportingNodes — which previously passed
  // because `allowed.some(...)` is vacuously false — straight into the signed receipt).
  const claimIds = new Set(graph.nodes.filter((n) => n.type === "Claim").map((n) => n.id));
  let citedUnknownNode = false;

  // VALIDATE citations but do NOT mutate the model's claims: a claim citing a node outside its structural
  // neighborhood (PUBLIC) and outside the packet's evidence leaves (PRIVATE) — OR a claimId that is not a
  // real Claim node — flags citedUnknownNode so the CALLER rejects the whole run (→ structural-only)
  // rather than silently editing the claims. Verdicts are returned VERBATIM here; the enclave attests
  // EXECUTION (responseHash:chatID), not the verdict content, and the caller applies the one-directional
  // support gate before persisting (trusted-transport verdicts).
  for (const claim of adjudication.claims) {
    if (!claimIds.has(claim.claimId)) {
      citedUnknownNode = true;
      continue;
    }
    const allowed = neighborhood.get(claim.claimId) ?? new Set<string>();
    if (claim.supportingNodes.some((id) => !allowed.has(id) && !privateLeafIds.has(id))) {
      citedUnknownNode = true;
    }
  }
  const verdicts: ClaimVerdict[] = adjudication.claims;

  return { graphHashMatches, verdicts, citedUnknownNode };
}

/**
 * INDEX-CITATION decode (public/skeleton path only). The model cites `supportingNodeIndices` (integer
 * indices into each claim's numbered supportingNodeTable). We map each index back to its id using
 * `orderedClaimSupporters` — the SAME deterministic ordering the request builder used to NUMBER the table.
 *
 * INDEX-ONLY: any model-supplied `supportingNodes` is IGNORED and rebuilt SOLELY from valid decoded
 * indices. This is what makes the honesty guard un-defeatable: a weak model can never reach
 * crossCheckAdjudication with a phantom raw id (so it can never reject the run), and out-of-range /
 * non-integer indices are simply DROPPED. Both fields are removed so the strict adjudicationV1 schema parses.
 *
 * FAIL CLOSED: a positive verdict (substantiated/inflated) that cited NO valid evidence index is downgraded
 * to unsupported — the TEE model's bare word never promotes a claim without a real, in-neighborhood citation
 * (defense-in-depth alongside the merge-layer support gate). Downgraded claims rejoin `abstained`.
 *
 * Applied PRODUCER-SIDE before parse; the resulting ids are what get hashed into verdictRoot. PRIVATE-tier
 * requests skip this entirely (they legitimately cite ids/leaf-ids and use the unchanged private path).
 */
export function mapSupportingIndicesToIds(raw: unknown, graph: ArtifactGraph): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.claims)) return raw;
  const ordered = orderedClaimSupporters(graph);
  const downgraded = new Set<string>();
  const claims = obj.claims.map((c) => {
    if (!c || typeof c !== "object") return c;
    const cc = c as Record<string, unknown>;
    const claimId = typeof cc.claimId === "string" ? cc.claimId : "";
    const table = ordered.get(claimId) ?? [];
    const rawIdx = Array.isArray(cc.supportingNodeIndices) ? (cc.supportingNodeIndices as unknown[]) : [];
    const ids = [...new Set(
      rawIdx
        .map((i) => (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < table.length ? table[i] : null))
        .filter((id): id is string => id !== null)
    )];
    // Drop BOTH the model's raw supportingNodes and the indices; rebuild supportingNodes from valid indices only.
    const { supportingNodeIndices: _dropIdx, supportingNodes: _dropRaw, ...rest } = cc;
    if ((cc.verdict === "substantiated" || cc.verdict === "inflated") && ids.length === 0) {
      if (claimId) downgraded.add(claimId);
      return { ...rest, supportingNodes: [], verdict: "unsupported", confidence: 0, abstainReason: "insufficient-public-evidence" };
    }
    return { ...rest, supportingNodes: ids };
  });
  const prevAbstained = Array.isArray(obj.abstained)
    ? (obj.abstained as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { ...obj, claims, abstained: [...new Set([...prevAbstained, ...downgraded])] };
}

/**
 * CAP HONESTY (mode 1, public path). When a claim's candidate table was TRUNCATED to `adjudicationTableCap`
 * (it had MORE structural supporters than we showed the model), a NEGATIVE verdict (unsupported/inflated)
 * is NOT trustworthy — the substantiating evidence may sit in the hidden tail the model never saw. Drop
 * such verdicts so the claim falls back to the structural-only floor (buildMergedEvidenceBadges), never a
 * confident attested negative on partial evidence. A SUBSTANTIATED verdict is KEPT: it cites a shown id,
 * so the positive judgment is sound regardless of what was hidden. Fully-shown claims are untouched.
 * The cap thus only ever ADDS positives; truncation can never manufacture a false negative.
 */
export function dropTruncatedNegativesOnCap(graph: ArtifactGraph, verdicts: ClaimVerdict[]): ClaimVerdict[] {
  const cap = adjudicationTableCap();
  const ordered = orderedClaimSupporters(graph);
  return verdicts.filter((v) => {
    const truncated = (ordered.get(v.claimId)?.length ?? 0) > cap;
    return !(truncated && v.verdict !== "substantiated");
  });
}

export type VerifySummary = {
  composeVerificationPassed?: boolean;
  signerAllMatch?: boolean;
  teeType?: string;
};

export type ServiceSummary = {
  provider: string;
  verifiability: string;
  teeSignerAcknowledged: boolean;
  teeSignerAddress: string;
  model: string;
};

/**
 * Minimal subset of the 0G Compute SDK broker that runAttestedAdjudicator drives.
 * The relayer constructs the real broker (createZGComputeNetworkBroker) and
 * passes it here; unit tests pass a mock. Kept structural so the SDK is never imported
 * into the verifier's type surface.
 */
export interface BrokerLike {
  inference: {
    listServiceWithDetail(
      offset?: number,
      limit?: number,
      includeUnacknowledged?: boolean
    ): Promise<ServiceSummary[]>;
    getServiceMetadata(providerAddress: string): Promise<{ endpoint: string; model: string }>;
    getRequestHeaders(providerAddress: string, content?: string): Promise<Record<string, string>>;
    /** Optional: register low-buffer auto-funding so getRequestHeaders SKIPS its hardcoded 2x
     *  check-and-fund and the provider sub-account is maintained at ~1x MIN_LOCKED (the provider's
     *  real floor) instead of 2x. Lets an already ~1 OG sub-account be reused without a fresh ~1 OG
     *  transfer. Optional so test broker mocks need not implement it. */
    startAutoFunding?(
      providerAddress: string,
      config?: { bufferMultiplier?: number; interval?: number },
      gasPrice?: number
    ): Promise<void>;
    processResponse(providerAddress: string, chatID?: string, content?: string): Promise<boolean | null>;
    verifyService(
      providerAddress: string,
      outputDir?: string,
      onLog?: (step: { type: string; message: string }) => void
    ): Promise<{
      composeVerification?: { passed: boolean };
      signerVerification?: { allMatch: boolean };
      reportsData?: { combined?: unknown; llm?: unknown; broker?: unknown };
    } | null>;
    getSignerRaDownloadLink(providerAddress: string): Promise<string>;
    getChatSignatureDownloadLink(providerAddress: string, chatID: string): Promise<string>;
  };
}

export class NoTeeMlProviderError extends Error {
  constructor() {
    super("no acknowledged TeeML provider available on the target network");
    this.name = "NoTeeMlProviderError";
  }
}

export function selectTeeMlProvider(
  services: ServiceSummary[],
  preferredProvider?: string
): ServiceSummary {
  const eligible = services.filter((s) => s.verifiability === "TeeML" && s.teeSignerAcknowledged === true);
  if (eligible.length === 0) {
    throw new NoTeeMlProviderError();
  }
  if (preferredProvider) {
    const pref = eligible.find((s) => s.provider.toLowerCase() === preferredProvider.toLowerCase());
    if (pref) return pref;
  }
  return eligible[0];
}

export function buildTeeAttestation(input: {
  providerAddress: string;
  signingAddress: string;
  /** REAL enclave signature over signedText (recovers to signingAddress). NEVER the Authorization header. */
  signature: string;
  /** The exact text the enclave put its signature over: `responseHash:chatID` (execution material), NOT the verdict JSON. */
  signedText: string;
  processResponseValid: boolean;
  verifySummary?: VerifySummary;
  quoteHash?: string;
  attestationQuoteUri?: string;
  raDownloadLink?: string;
  chatSignatureLink?: string;
  verifiedBy: string;
  verifiedAt: string;
}): TeeAttestation {
  return {
    scheme: "0g-teeml",
    // The signature attests TEE EXECUTION + a provider response-hash (signedText = `responseHash:chatID`),
    // recovering to the signer named by the attestation (on-chain acknowledgement is NOT checked).
    // It does NOT bind the verdict content.
    attests: "tee-execution",
    providerAddress: input.providerAddress,
    signingAddress: input.signingAddress,
    signature: input.signature,
    // keccak `hashMessage` over exactly the text the enclave put its signature over (the
    // `responseHash:chatID`); recover the signer from (signature, signedDigest). Real TEE-execution proof.
    signedDigest: hashMessage(input.signedText),
    // SHA-256 `canonicalHash` over the SIGNED `responseHash:chatID` (execution material), NOT the verdict
    // content — ties the signed text to VibeTrace's hash world. DISTINCT from signedDigest.
    responseTextHash: canonicalHash(input.signedText),
    processResponseValid: input.processResponseValid,
    teeType: input.verifySummary?.teeType,
    composeVerificationPassed: input.verifySummary?.composeVerificationPassed,
    signerAllMatch: input.verifySummary?.signerAllMatch,
    attestationQuoteUri: input.attestationQuoteUri,
    quoteHash: input.quoteHash,
    raDownloadLink: input.raDownloadLink,
    chatSignatureLink: input.chatSignatureLink,
    verifiedAt: input.verifiedAt,
    verifiedBy: input.verifiedBy
  };
}

export type QuoteStorage = { uploadJson(value: unknown): Promise<{ rootHash: string; uri: string }> };

/** A VerifierRun the attested path ALWAYS fully populates — attestation/verdicts/verdictRoot are required
 *  (unlike the base VerifierRun where they are optional). This is what makes AttestedResult assignable to
 *  the relayer's RelayerResult (whose verifierRun.attestation is required). */
export type AttestedVerifierRun = VerifierRun & {
  attestation: TeeAttestation;
  verdicts: ClaimVerdict[];
  verdictRoot: string;
};

export type AttestedResult = {
  verifierRun: AttestedVerifierRun;
  evidenceBadges: EvidenceBadge[];
  /** TRANSIENT: the exact text the enclave put its signature over — `responseHash:chatID` (the EXECUTION
   *  material, NOT the verdict JSON). Used by the client to re-derive the TEE-EXECUTION proof
   *  (validateAttestationLocally), then discarded; NEVER persisted in the public bundle. */
  signedText: string;
};

export type AttestedAdjudicatorOptions = {
  graph: ArtifactGraph;
  broker: BrokerLike;
  quoteStorage: QuoteStorage;
  verifiedBy: string;
  fetchImpl?: typeof fetch;
  preferredProvider?: string;
  /** Sealed/trusted-transport private packet. */
  privatePacket?: unknown;
  now?: () => string;
};

/**
 * Fetch the REAL per-response enclave signature and verify it locally.
 * The SDK exposes the download link via getChatSignatureDownloadLink(provider, chatID)
 * → `${svc.url}/v1/proxy/signature/${chatID}`. The provider returns { text, signature }
 * where text is `responseHash:chatID` — a provider-computed response hash joined to the chatID,
 * NOT the verdict JSON. We verify with the same crypto the SDK uses:
 * recoverAddress(hashMessage(text), signature) === signingAddress. This proves the TEE signer named
 * by the attestation EXECUTED inference for this chatID (TEE-execution attestation); it does NOT
 * prove that signer is acknowledged in the provider's on-chain registry (we do not check that). It
 * does NOT bind the verdict content — verdicts are derived from the response `content` and relayed by
 * the operator (trusted transport).
 */
async function fetchAndVerifyEnclaveSignature(args: {
  broker: BrokerLike;
  providerAddress: string;
  signingAddress: string;
  chatID: string;
  model: string;
  fetchImpl: typeof fetch;
}): Promise<{ signature: string; signedText: string; chatSignatureLink?: string }> {
  const link = await args.broker.inference
    .getChatSignatureDownloadLink(args.providerAddress, args.chatID)
    .catch(() => undefined);
  if (!link) {
    throw new Error("0G Compute adjudicator: no chat signature download link available");
  }
  const sep = link.includes("?") ? "&" : "?";
  const res = await args.fetchImpl(`${link}${sep}model=${encodeURIComponent(args.model)}`, { method: "GET" });
  if (!res.ok) {
    throw new Error(`0G Compute adjudicator: signature fetch HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { text?: string; signature?: string };
  // REQUIRE the enclave's own signed text (`responseHash:chatID`). NEVER fall back to the completion
  // content: that would make signedText the verdict JSON, contradicting the responseHash:chatID framing
  // and mislabeling signedDigest/responseTextHash as if they hashed the verdicts.
  const signedText = typeof payload.text === "string" ? payload.text : "";
  if (!signedText) {
    throw new Error("0G Compute adjudicator: enclave returned no signed response text");
  }
  // Light shape check: the execution material is `responseHash:chatID`, so it must contain a ':' separator.
  if (!signedText.includes(":")) {
    throw new Error("0G Compute adjudicator: signed response text is not in responseHash:chatID form");
  }
  const signature = payload.signature;
  if (!signature) {
    throw new Error("0G Compute adjudicator: enclave returned no signature");
  }
  const recovered = recoverAddress(hashMessage(signedText), signature);
  if (recovered.toLowerCase() !== args.signingAddress.toLowerCase()) {
    throw new Error(
      `0G Compute adjudicator: enclave signature does not recover to signingAddress (${recovered} != ${args.signingAddress})`
    );
  }
  return { signature, signedText, chatSignatureLink: link };
}

export async function runAttestedAdjudicator(options: AttestedAdjudicatorOptions): Promise<AttestedResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const fetchImpl = options.fetchImpl ?? fetch;
  const { broker, graph } = options;

  const services = await broker.inference.listServiceWithDetail(0, 50, false);
  const provider = selectTeeMlProvider(services, options.preferredProvider);

  const { endpoint, model } = await broker.inference.getServiceMetadata(provider.provider);
  // TIER: a request is PRIVATE iff a private packet is attached; otherwise PUBLIC-only. The tier
  // drives both the crossCheck citation gate (private packets contribute valid evidence-leaf ids)
  // and whether the public-support downgrade runs (it must NOT, on the private path — the CLI's
  // upgradeVerdictsWithPacket + packetCoversClaim is the authoritative private gate).
  const privatePacket = options.privatePacket as
    | { leaves: PrivateLeaf[]; evidenceRoot: string }
    | undefined;
  const { body, requestHash } = buildAdjudicationRequest(graph, model, privatePacket);
  // Fund at the provider's REAL floor (1x MIN_LOCKED), not the SDK's default 2x client-side buffer.
  // Registering auto-funding makes the next getRequestHeaders skip its hardcoded checkAndFund(provider, 2),
  // so a sub-account already holding ~1 OG is reused instead of the SDK demanding a fresh ~1 OG transfer
  // (which fails when the ledger's available balance is below ~2 OG). Best-effort: ignore if unsupported.
  // Fund at the provider's REAL floor (1x MIN_LOCKED), not the SDK's default 2x client-side buffer:
  // registering low-buffer auto-funding makes getRequestHeaders skip its hardcoded checkAndFund(provider, 2),
  // halving the per-sub-account funding requirement. Best-effort (optional on mocks; non-fatal if it can't fund).
  try { await broker.inference.startAutoFunding?.(provider.provider, { bufferMultiplier: 1 }); } catch { /* best-effort */ }
  const headers = await broker.inference.getRequestHeaders(provider.provider, JSON.stringify(body));

  const response = await fetchImpl(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`0G Compute adjudicator HTTP error: ${response.status} ${await response.text()}`);
  }

  const completion = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const chatID = response.headers.get("ZG-Res-Key") || completion.id || undefined;
  const content = String(completion.choices?.[0]?.message?.content ?? "");
  if (!content) {
    throw new Error("0G Compute adjudicator returned empty content");
  }
  if (!chatID) {
    throw new Error("0G Compute adjudicator returned no chat id (cannot fetch the response signature)");
  }

  // PUBLIC path: the model cited supportingNodeIndices into the per-claim numbered table — decode them
  // back to ids (deterministic, in-neighborhood by construction) BEFORE the strict parse + cross-check.
  // PRIVATE path cites ids/leaf-ids directly, so it skips the decode.
  const normalized = normalizeAdjudicationEnums(JSON.parse(extractAdjudicationJson(content)));
  const decoded = privatePacket ? normalized : mapSupportingIndicesToIds(normalized, graph);
  const adjudication: AdjudicationV1 = parseAdjudicationV1(decoded);
  const cross = crossCheckAdjudication(adjudication, graph, privatePacket);
  if (!cross.graphHashMatches) {
    throw new Error("0G Compute adjudicator graphHash echo mismatch — run rejected");
  }
  if (cross.citedUnknownNode) {
    throw new Error("0G Compute adjudicator cited a node outside the claim's structural neighborhood — run rejected");
  }

  const processResponseValid = await broker.inference.processResponse(
    provider.provider,
    chatID,
    JSON.stringify(completion.usage ?? {})
  );
  if (processResponseValid !== true) {
    throw new Error("0G Compute response not independently attested (processResponse !== true)");
  }

  // Fetch + locally verify the REAL enclave signature over the response text.
  const { signature, signedText, chatSignatureLink } = await fetchAndVerifyEnclaveSignature({
    broker,
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    chatID,
    model,
    fetchImpl
  });

  let verifySummary: VerifySummary | undefined;
  try {
    // verifyService writes the downloaded RA report into this dir but does NOT create it; mkdir first so
    // a missing dir doesn't ENOENT and silently drop the compose/signer verification (observed live).
    await mkdir("/tmp/vt-tee", { recursive: true });
    const vr = await broker.inference.verifyService(provider.provider, "/tmp/vt-tee");
    if (vr) {
      verifySummary = {
        composeVerificationPassed: vr.composeVerification?.passed,
        signerAllMatch: vr.signerVerification?.allMatch,
        teeType: vr.reportsData?.combined || vr.reportsData?.llm ? "TDX" : undefined
      };
    }
  } catch {
    verifySummary = undefined;
  }

  const quote = await options.quoteStorage.uploadJson({
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    verifySummary: verifySummary ?? null,
    chatID,
    capturedAt: now()
  });

  const raDownloadLink = await broker.inference.getSignerRaDownloadLink(provider.provider).catch(() => undefined);

  const attestation: TeeAttestation = buildTeeAttestation({
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    signature,
    signedText,
    processResponseValid: true,
    verifySummary,
    quoteHash: quote.rootHash,
    attestationQuoteUri: quote.uri,
    raDownloadLink,
    chatSignatureLink,
    verifiedBy: options.verifiedBy,
    verifiedAt: now()
  });

  // Verdicts come from the enclave's RESPONSE CONTENT (parsed + cross-checked above). The enclave signs
  // `responseHash:chatID` (attesting EXECUTION), NOT the verdict JSON, so we DO NOT re-parse signedText
  // as an adjudication — the provider's responseHash is not client-reproducible.
  //
  // TIER-AWARE HONESTY GATE (parity with the merge table's one-directional gate): on the PUBLIC-only
  // path, a positive verdict (substantiated/inflated) for a claim that has NO file-only `supports` edge
  // in the graph is downgraded to "unsupported" BEFORE we persist it (the verdict word feeds the
  // viewer/registry HEADLINE, so a no-support "substantiated" must not survive). On the PRIVATE path we
  // do NOT apply this public-support downgrade — a private-tier verdict is LEGITIMATELY substantiated by
  // packet evidence that has no public `supports` edge. The authoritative private gate is the CLI's
  // upgradeVerdictsWithPacket + packetCoversClaim (one-directional, evidence-leaf-keyed).
  const verdicts: ClaimVerdict[] = privatePacket
    ? cross.verdicts
    : downgradeUnsupportedVerdicts(graph, dropTruncatedNegativesOnCap(graph, cross.verdicts));

  // Merge the attested verdicts with the structural floor: an attested inflated/unsupported
  // verdict downgrades the badge to "partial" with verdict + provenance:"structural+attested"; claims
  // with no verdict keep the structural-only floor.
  const evidenceBadges = buildMergedEvidenceBadges(graph, verdicts);

  const output = {
    graphHash: graph.canonicalHash,
    verdicts,
    evidenceBadges,
    citedUnknownNode: cross.citedUnknownNode
  };

  // verdictRoot = canonicalHash over the PERSISTED ClaimVerdict[] (client-recomputable from run.verdicts).
  // This is tamper-HYGIENE only (a hostile relayer can make it self-consistent), NOT a cryptographic
  // verdict binding. `abstained` is NOT persisted on VerifierRun, so it is excluded from this hash.
  const verdictRoot = canonicalHash(verdicts);

  // Determine evidence tier from the injected packet.
  const packetAny = options.privatePacket as { evidenceRoot?: string } | undefined;

  const verifierRun: AttestedVerifierRun = {
    verifierId: "vibetrace-attested-adjudicator",
    provider: "0g-compute",
    model,
    requestHash,
    responseHash: canonicalHash(completion),
    outputHash: canonicalHash(output),
    createdAt: now(),
    summary: `Examined by ${model} in an attested 0G TEE: ${verdicts.length} claim${verdicts.length === 1 ? "" : "s"} judged.`,
    attestation,
    verdicts,
    verdictRoot,
    evidenceTier: packetAny ? "private" : "public-only",
    ...(packetAny?.evidenceRoot !== undefined ? { privateEvidenceRoot: packetAny.evidenceRoot } : {})
  };

  return { verifierRun, evidenceBadges, signedText };
}
