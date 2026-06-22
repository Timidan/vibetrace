import { canonicalHash } from "@vibetrace/schema";
import type { ClaimVerdict, EvidenceBadge, TeeAttestation, VerifierRun } from "@vibetrace/schema";

/** One revealable unit of private evidence sealed to the enclave. */
export type PacketLeaf = {
  kind:
    | "diff"
    | "file-excerpt"
    | "test-output"
    | "claim-list"
    | "public-bundle-hash"
    | "snapshot-hash";
  /** Stable identifier: a file path, a claim id, or a fixed key like "claim-list". */
  id: string;
  /** The actual private content (diff text, file excerpt, test log, etc.). */
  content: string;
};

/**
 * Bind a leaf's kind+id+content into a single hash. Membership of this leaf in
 * the packet is later provable against PrivatePacket.evidenceRoot, so the
 * builder can selectively reveal one leaf without revealing the rest.
 */
export function leafHash(leaf: PacketLeaf): string {
  return canonicalHash({ kind: leaf.kind, id: leaf.id, content: leaf.content });
}

const EMPTY_MERKLE_ROOT = canonicalHash("vibetrace.private-packet.empty");

function redactionToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function idMatchesPattern(id: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return id === prefix || id.startsWith(`${prefix}/`);
  }
  // Match EITHER the full leaf id OR the unprefixed path portion.
  // Leaves are keyed "file:<path>" / "diff:<path>"; a bare "<path>" pattern
  // should match both forms so --redact src/secret.ts drops "file:src/secret.ts".
  const re = redactionToRegExp(pattern);
  if (re.test(id)) return true;
  // Strip a single "word:" prefix and test again.
  const colonIdx = id.indexOf(":");
  if (colonIdx !== -1) {
    const bare = id.slice(colonIdx + 1);
    if (re.test(bare)) return true;
  }
  return false;
}

/**
 * Drop any leaf whose id matches one of the redaction globs, BEFORE the Merkle
 * root is computed — so a redacted leaf is provably absent from the packet.
 * Pure: never mutates the input.
 */
export function applyRedactions(leaves: PacketLeaf[], patterns: string[]): PacketLeaf[] {
  if (patterns.length === 0) return [...leaves];
  return leaves.filter((leaf) => !patterns.some((p) => idMatchesPattern(leaf.id, p)));
}

/** The sealed packet sent ONLY to the TEE — never persisted in the public bundle. */
export type PrivatePacket = {
  schemaVersion: "vibetrace.private-packet.v1";
  publicBundleHash: string;
  snapshotHash: string;
  claimIds: string[];
  leaves: PacketLeaf[];
  evidenceRoot: string;
  transport: "sealed" | "trusted-transport";
};

export type AssemblePacketInput = {
  publicBundleHash: string;
  snapshotHash: string;
  claimIds: string[];
  fileExcerpts?: Array<{ path: string; content: string }>;
  diffs?: Array<{ path: string; content: string }>;
  testOutput?: string;
  /** Redaction globs applied to leaf ids before the root is computed. */
  redact?: string[];
  /** Only true when an exported enclave-encryption path is confirmed. */
  sealedTransportConfirmed?: boolean;
};

/**
 * Deterministically assemble the sealed Private Adjudication Packet. Leaves are
 * sorted by (kind,id); redactions are applied BEFORE the Merkle root so a
 * redacted leaf is provably absent. Default transport is trusted-transport;
 * only confirmed sealing flips it to "sealed".
 */
export function assemblePrivatePacket(input: AssemblePacketInput): PrivatePacket {
  const claimIds = [...input.claimIds].sort();
  const leaves: PacketLeaf[] = [
    { kind: "public-bundle-hash", id: "public-bundle-hash", content: input.publicBundleHash },
    { kind: "snapshot-hash", id: "snapshot-hash", content: input.snapshotHash },
    { kind: "claim-list", id: "claim-list", content: JSON.stringify(claimIds) }
  ];
  for (const ex of input.fileExcerpts ?? []) {
    leaves.push({ kind: "file-excerpt", id: `file:${ex.path}`, content: ex.content });
  }
  for (const d of input.diffs ?? []) {
    leaves.push({ kind: "diff", id: `diff:${d.path}`, content: d.content });
  }
  if (typeof input.testOutput === "string" && input.testOutput.length > 0) {
    leaves.push({ kind: "test-output", id: "test-output", content: input.testOutput });
  }

  const redacted = applyRedactions(leaves, input.redact ?? []);
  redacted.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  return {
    schemaVersion: "vibetrace.private-packet.v1",
    publicBundleHash: input.publicBundleHash,
    snapshotHash: input.snapshotHash,
    claimIds,
    leaves: redacted,
    evidenceRoot: merkleRoot(redacted.map(leafHash)),
    transport: input.sealedTransportConfirmed ? "sealed" : "trusted-transport"
  };
}

/**
 * Lines the CLI prints BEFORE sending the packet. Shows every leaf id by
 * category, the claim list, the evidence root, and the transport mode in plain
 * words — preserving the `collect` disclosure ethos (no silent privacy
 * downgrade: trusted-transport means the relayer can read the packet).
 */
export function renderPacketDisclosure(packet: PrivatePacket): string[] {
  const byKind = (kind: PacketLeaf["kind"]): string[] =>
    packet.leaves.filter((l) => l.kind === kind).map((l) => l.id);

  const lines: string[] = [];
  lines.push("VibeTrace private packet — opt-in evidence sealed to the examiner");
  lines.push("  This is sent ONLY to the TEE adjudicator and is NEVER persisted in the public bundle.");
  lines.push(`  Public commitment in the receipt: privateEvidenceRoot = ${packet.evidenceRoot}`);
  lines.push(`  Claims it will judge: ${packet.claimIds.join(", ") || "(none)"}`);

  const excerpts = byKind("file-excerpt");
  lines.push(`  File excerpts (${excerpts.length}): ${excerpts.join(", ") || "(none)"}`);
  const diffs = byKind("diff");
  lines.push(`  Diffs (${diffs.length}): ${diffs.join(", ") || "(none)"}`);
  const tests = byKind("test-output");
  lines.push(`  Test output: ${tests.length ? "included (test-output)" : "(none)"}`);

  if (packet.transport === "sealed") {
    lines.push("  Transport: SEALED — the packet is encrypted to the enclave; the relayer cannot read it.");
  } else {
    lines.push("  Transport: TRUSTED-TRANSPORT — sealed enclave encryption is unproven, so the relayer can read this packet.");
    lines.push("  Redact anything you do not want the relayer to see with --redact <glob> (repeatable).");
  }
  return lines;
}

const DEFAULT_EXCERPT_BYTES = 4096;

/**
 * Read excerpts for the given repo-relative paths via an injected reader,
 * truncated to a byte cap (privacy-preserving, mirrors collect's excerpt
 * redaction). Unreadable paths are skipped. Output is sorted by path.
 */
export async function gatherFileExcerpts(
  paths: string[],
  read: (path: string) => Promise<string | undefined>,
  opts: { maxBytes?: number } = {}
): Promise<Array<{ path: string; content: string }>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_EXCERPT_BYTES;
  const out: Array<{ path: string; content: string }> = [];
  for (const path of [...new Set(paths)].sort()) {
    const raw = await read(path);
    if (typeof raw !== "string") continue;
    out.push({ path, content: raw.length > maxBytes ? raw.slice(0, maxBytes) : raw });
  }
  return out;
}

/**
 * Deterministic binary Merkle root over a list of leaf hashes (0x-hex SHA-256
 * strings). Each internal node = canonicalHash of the two child hex strings
 * concatenated in SORTED order (so swapping two siblings cannot change the
 * root). An odd node at any level is paired with itself (duplicate-last).
 * Empty -> a fixed sentinel; single leaf -> that leaf.
 */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return EMPTY_MERKLE_ROOT;
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const [lo, hi] = left < right ? [left, right] : [right, left];
      next.push(canonicalHash(`${lo}${hi}`));
    }
    level = next;
  }
  return level[0];
}

/** Leaf kinds that actually carry substantiating evidence (NOT commitments/metadata). */
const EVIDENCE_LEAF_KINDS: ReadonlySet<PacketLeaf["kind"]> = new Set([
  "file-excerpt",
  "diff",
  "test-output"
]);

/**
 * True iff at least one of the verdict's supportingNodes corresponds to an
 * EVIDENCE-BEARING leaf actually present in the packet (file-excerpt, diff, or
 * test-output). This is the evidence gate: a claim can only be promoted off the
 * packet if the packet carries real evidence the verdict cites.
 *
 * The commitment/metadata leaves (`claim-list`, `public-bundle-hash`,
 * `snapshot-hash`) are DELIBERATELY excluded — they substantiate nothing, and a
 * hostile relayer must not be able to pass this gate by citing e.g. `claim-list`.
 */
export function packetCoversClaim(packet: PrivatePacket, verdict: ClaimVerdict): boolean {
  const evidenceLeafIds = new Set(
    packet.leaves.filter((l) => EVIDENCE_LEAF_KINDS.has(l.kind)).map((l) => l.id)
  );
  // A cited node covers the claim only if it names an evidence-bearing leaf id
  // (leaf ids are keyed "file:<path>" / "diff:<path>" / "test-output").
  return verdict.supportingNodes.some((node) => evidenceLeafIds.has(node));
}

/**
 * Deterministic LOCAL guard around the TEE private-tier result. For each claim,
 * accept the private substantiated verdict ONLY when (a) the public-only run
 * abstained with insufficient-public-evidence, (b) the private run returned
 * "substantiated", and (c) the packet actually covers the claim. Otherwise keep
 * the public-only verdict. Mirrors the §6 one-directional gate: a packet's mere
 * presence cannot promote a claim it carries no evidence for.
 */
export function upgradeVerdictsWithPacket(
  publicOnly: ClaimVerdict[],
  privateRun: ClaimVerdict[],
  packet: PrivatePacket
): ClaimVerdict[] {
  const privateById = new Map(privateRun.map((v) => [v.claimId, v]));
  return publicOnly.map((pub) => {
    const wasAbstained =
      pub.verdict === "unsupported" && pub.abstainReason === "insufficient-public-evidence";
    if (!wasAbstained) return pub;
    const priv = privateById.get(pub.claimId);
    if (!priv || priv.verdict !== "substantiated") return pub;
    if (!packetCoversClaim(packet, priv)) return pub;
    return priv;
  });
}

/**
 * Build a public-safe verifierRun from a private-tier adjudication result.
 *
 * PRIVACY CONTRACT: No text derived from private-packet leaf content may appear
 * in the public bundle. Any field that the TEE might have populated with
 * private-evidence text is stripped or replaced with a neutral fixed string.
 *
 * Allowed fields: verifierId, provider, model, requestHash, responseHash,
 * outputHash, createdAt, attestation, verdictRoot, evidenceTier, privateEvidenceRoot.
 * Verdicts are included but each verdict's `rationale` is replaced with a fixed
 * neutral string to prevent private-evidence bleed. Summary is replaced with a
 * fixed safe message.
 */
export function buildPublicSafeVerifierRun(
  run: VerifierRun,
  opts: { privateEvidenceRoot: string; allowedClaimIds: ReadonlySet<string> }
): VerifierRun {
  // EXPLICIT WHITELIST (not spread): construct each verdict from ONLY approved schema fields, so a
  // hostile/buggy private-tier adjudicator cannot smuggle extra fields into the public bundle. The
  // rationale (free text) is scrubbed; supportingNodes are public node ids (already in the graph).
  const safeVerdicts: ClaimVerdict[] = (run.verdicts ?? [])
    // Drop any verdict whose claimId is not a real public Claim node (no arbitrary-claimId injection).
    .filter((v) => opts.allowedClaimIds.has(v.claimId))
    .map((v) => {
    const d = v.dimensions ?? ({} as ClaimVerdict["dimensions"]);
    return {
      claimId: v.claimId,
      verdict: v.verdict,
      confidence: v.confidence,
      // DROP verdict supportingNodes for private-tier: a hostile/buggy response could inject arbitrary
      // strings (e.g. "diff:SECRET") here, and a prefix filter alone would not stop content. The
      // public-safe file: supporters live on the merged badge (buildPublicSafeBadges); the private
      // evidence is committed via privateEvidenceRoot. So the public verdict carries the word + claimId.
      supportingNodes: [],
      rationale: "Rationale withheld — derived from private evidence.",
      abstainReason: v.abstainReason ?? null,
      // EXPLICIT dimensions whitelist — pick ONLY the three known enum sub-fields (drops any nested
      // injected field) and coerce each to a valid enum value (drops an injected non-enum string).
      dimensions: {
        relevance: (["strong", "weak", "none"] as const).includes(d.relevance) ? d.relevance : "none",
        sufficiency: (["proportionate", "thin", "absent"] as const).includes(d.sufficiency) ? d.sufficiency : "absent",
        contradiction: (["none", "present"] as const).includes(d.contradiction) ? d.contradiction : "none"
      }
    };
  });

  // EXPLICIT WHITELIST for the attestation: ONLY the approved crypto/hash/hardware fields (all safe —
  // hashes/signatures). Any unknown field is dropped, and `chatSignatureLink` is deliberately OMITTED —
  // it retrieves the signed private-tier RESPONSE text. The attestation stays cryptographically
  // verifiable without it (recoverAddress(signedDigest, signature) === signingAddress needs no link).
  const a = run.attestation;
  const safeAttestation: TeeAttestation | undefined = a
    ? {
        scheme: a.scheme,
        // The honest TEE-execution marker MUST survive sanitization so consumers can gate TEE status on
        // it (a private-tier bundle that drops `attests` would be wrongly treated as not-TEE-attested).
        attests: a.attests,
        providerAddress: a.providerAddress,
        signingAddress: a.signingAddress,
        signature: a.signature,
        signedDigest: a.signedDigest,
        // signedText = `responseHash:chatID` (a hash + an opaque id, NOT response content) — kept so
        // consumers can verify hashMessage(signedText) === signedDigest. Distinct from the OMITTED
        // chatSignatureLink, which retrieves the actual response text.
        signedText: a.signedText,
        responseTextHash: a.responseTextHash,
        processResponseValid: a.processResponseValid,
        teeType: a.teeType,
        composeVerificationPassed: a.composeVerificationPassed,
        signerAllMatch: a.signerAllMatch,
        attestationQuoteUri: a.attestationQuoteUri,
        quoteHash: a.quoteHash,
        raDownloadLink: a.raDownloadLink,
        verifiedAt: a.verifiedAt,
        verifiedBy: a.verifiedBy
      }
    : a;

  return {
    // Structural identity fields — safe (hashes only, no content)
    verifierId: run.verifierId,
    provider: run.provider,
    model: run.model,
    requestHash: run.requestHash,
    responseHash: run.responseHash,
    outputHash: run.outputHash,
    createdAt: run.createdAt,
    // Summary: replace any TEE-generated string (may echo packet content) with a fixed safe message.
    summary: `Private-tier adjudication. Evidence committed to privateEvidenceRoot ${opts.privateEvidenceRoot}.`,
    // Attestation with chatSignatureLink stripped (see above) — crypto-verifiable, no private-text path.
    attestation: safeAttestation,
    // verdictRoot MUST hash the FINAL public-safe verdicts (after allowedClaimIds filtering + scrub),
    // NOT the raw input root — otherwise a re-checker's canonicalHash(verdicts) !== verdictRoot. This is
    // the tamper-hygiene tie for the PUBLISHED verdicts.
    verdictRoot: canonicalHash(safeVerdicts),
    // Tier and root — the only private-evidence fields allowed publicly
    evidenceTier: "private",
    privateEvidenceRoot: opts.privateEvidenceRoot,
    // Verdicts with rationales scrubbed
    verdicts: safeVerdicts
  };
}

/**
 * Public-safe evidence badges for a private-tier run. The structural fields (claimId, status,
 * confidence, supportingNodes — file: ids that are already in the public graph, provenance, verdict
 * word) are public; but `publicExplanation` is FREE TEXT that a private-tier adjudicator/relayer could
 * fill with private-derived content, so it is replaced with a fixed public-safe string.
 */
export function buildPublicSafeBadges(
  badges: EvidenceBadge[],
  allowedClaimIds: ReadonlySet<string>
): EvidenceBadge[] {
  // EXPLICIT WHITELIST (not spread): drop badges whose claimId is not a real public Claim; keep only
  // approved schema fields; replace publicExplanation (free text); filter supportingNodes to file: ids.
  return badges
    .filter((b) => allowedClaimIds.has(b.claimId))
    .map((b) => ({
    claimId: b.claimId,
    status: b.status,
    confidence: b.confidence,
    supportingNodes: (b.supportingNodes ?? []).filter((id) => id.startsWith("file:")),
    publicExplanation: "Evidence withheld — private-tier adjudication (committed via privateEvidenceRoot).",
    provenance: b.provenance,
    verdict: b.verdict
  }));
}
