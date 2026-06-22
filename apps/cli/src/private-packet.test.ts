import { describe, expect, it } from "vitest";
import { canonicalHash } from "@vibetrace/schema";
import { merkleRoot, leafHash, applyRedactions, type PacketLeaf } from "./private-packet";
import { gatherFileExcerpts } from "./private-packet";

const EMPTY_ROOT = canonicalHash("vibetrace.private-packet.empty");
// Allowed public Claim ids for the public-safe sanitizers (the fixtures all use claim:x).
const ALLOWED_CLAIMS = new Set(["claim:x"]);

describe("merkleRoot", () => {
  it("returns the empty sentinel for no leaves", () => {
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
  });

  it("returns the single leaf hash unchanged for one leaf", () => {
    const leaf = canonicalHash("a");
    expect(merkleRoot([leaf])).toBe(leaf);
  });

  it("hashes a pair as canonicalHash of the SORTED [lo,hi] concat", () => {
    const a = canonicalHash("a");
    const b = canonicalHash("b");
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const expected = canonicalHash(`${lo}${hi}`);
    expect(merkleRoot([a, b])).toBe(expected);
    // sorted-pair => order of the two inputs does not change the root
    expect(merkleRoot([b, a])).toBe(expected);
  });

  it("duplicates the last node for an odd count at a level", () => {
    const a = canonicalHash("a");
    const b = canonicalHash("b");
    const c = canonicalHash("c");
    const pairAB = (() => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return canonicalHash(`${lo}${hi}`);
    })();
    const pairCC = canonicalHash(`${c}${c}`);
    const [lo, hi] = pairAB < pairCC ? [pairAB, pairCC] : [pairCC, pairAB];
    const expected = canonicalHash(`${lo}${hi}`);
    expect(merkleRoot([a, b, c])).toBe(expected);
  });

  it("is deterministic across calls", () => {
    const leaves = ["x", "y", "z", "w"].map((s) => canonicalHash(s));
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });
});

describe("applyRedactions", () => {
  const leaves: PacketLeaf[] = [
    { kind: "file-excerpt", id: "file:src/auth.ts", content: "a" },
    { kind: "file-excerpt", id: "file:src/secret.env.ts", content: "b" },
    { kind: "diff", id: "diff:packages/og/secret.ts", content: "c" },
    { kind: "test-output", id: "test:run", content: "d" }
  ];

  it("returns all leaves when no patterns given", () => {
    expect(applyRedactions(leaves, [])).toHaveLength(4);
  });

  it("drops leaves whose id matches an exact-suffix glob (** crosses slashes)", () => {
    const kept = applyRedactions(leaves, ["**secret.env.ts"]);
    expect(kept.map((l) => l.id)).toEqual([
      "file:src/auth.ts",
      "diff:packages/og/secret.ts",
      "test:run"
    ]);
  });

  it("single-star * does NOT cross path separators", () => {
    // "*secret.env.ts" matches only single-segment ids with no "/" before the suffix
    const singleSegmentLeaves: PacketLeaf[] = [
      { kind: "file-excerpt", id: "secret.env.ts", content: "x" },
      { kind: "file-excerpt", id: "src/secret.env.ts", content: "y" }
    ];
    const kept = applyRedactions(singleSegmentLeaves, ["*secret.env.ts"]);
    // Only the no-slash id is matched; the one with "/" is not
    expect(kept.map((l) => l.id)).toEqual(["src/secret.env.ts"]);
  });

  it("drops leaves matching a ** path glob", () => {
    const kept = applyRedactions(leaves, ["diff:packages/og/**"]);
    expect(kept.map((l) => l.id)).toEqual([
      "file:src/auth.ts",
      "file:src/secret.env.ts",
      "test:run"
    ]);
  });

  it("matches with a leading-star substring pattern (** crosses slashes)", () => {
    const kept = applyRedactions(leaves, ["**secret**"]);
    expect(kept.map((l) => l.id)).toEqual(["file:src/auth.ts", "test:run"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...leaves];
    applyRedactions(leaves, ["*"]);
    expect(leaves).toEqual(copy);
  });

  it("drops a leaf when the redact pattern matches the bare path (without prefix)", () => {
    // --redact src/secret.env.ts should drop the leaf whose id is "file:src/secret.env.ts"
    const kept = applyRedactions(leaves, ["src/secret.env.ts"]);
    expect(kept.find((l) => l.id === "file:src/secret.env.ts")).toBeUndefined();
    // but leaves with a different path are untouched
    expect(kept.find((l) => l.id === "file:src/auth.ts")).toBeDefined();
  });
});

describe("leafHash", () => {
  const leaf: PacketLeaf = { kind: "file-excerpt", id: "file:src/auth.ts", content: "export const x = 1;" };

  it("binds kind+id+content via canonicalHash", () => {
    expect(leafHash(leaf)).toBe(
      canonicalHash({ kind: leaf.kind, id: leaf.id, content: leaf.content })
    );
  });

  it("changes when content changes", () => {
    const other: PacketLeaf = { ...leaf, content: "export const x = 2;" };
    expect(leafHash(other)).not.toBe(leafHash(leaf));
  });

  it("changes when kind changes even with identical id+content", () => {
    const other: PacketLeaf = { ...leaf, kind: "diff" };
    expect(leafHash(other)).not.toBe(leafHash(leaf));
  });
});

import { assemblePrivatePacket, merkleRoot as mRoot, leafHash as lHash, type PrivatePacket, renderPacketDisclosure, upgradeVerdictsWithPacket, packetCoversClaim } from "./private-packet";

describe("gatherFileExcerpts", () => {
  const fs = new Map<string, string>([
    ["src/auth.ts", "a".repeat(50)],
    ["src/pay.ts", "b".repeat(5000)]
  ]);
  const read = async (p: string): Promise<string | undefined> => fs.get(p);

  it("reads listed files and truncates to the byte cap", async () => {
    const out = await gatherFileExcerpts(["src/auth.ts", "src/pay.ts"], read, { maxBytes: 100 });
    expect(out).toEqual([
      { path: "src/auth.ts", content: "a".repeat(50) },
      { path: "src/pay.ts", content: "b".repeat(100) }
    ]);
  });

  it("skips files that cannot be read", async () => {
    const out = await gatherFileExcerpts(["src/auth.ts", "missing.ts"], read, { maxBytes: 100 });
    expect(out.map((e) => e.path)).toEqual(["src/auth.ts"]);
  });

  it("returns paths in sorted order", async () => {
    const out = await gatherFileExcerpts(["src/pay.ts", "src/auth.ts"], read);
    expect(out.map((e) => e.path)).toEqual(["src/auth.ts", "src/pay.ts"]);
  });
});

describe("assemblePrivatePacket", () => {
  const base = {
    publicBundleHash: "0x" + "a".repeat(64),
    snapshotHash: "0x" + "b".repeat(64),
    claimIds: ["claim:oauth", "claim:payments"],
    fileExcerpts: [
      { path: "src/auth.ts", content: "export const oauth = true;" },
      { path: "src/pay.ts", content: "export const pay = true;" }
    ],
    diffs: [{ path: "src/auth.ts", content: "+oauth" }],
    testOutput: "12 passed"
  };

  it("includes the three commitment leaves plus excerpt/diff/test leaves", () => {
    const packet = assemblePrivatePacket(base);
    const kinds = packet.leaves.map((l) => `${l.kind}:${l.id}`).sort();
    expect(kinds).toContain("public-bundle-hash:public-bundle-hash");
    expect(kinds).toContain("snapshot-hash:snapshot-hash");
    expect(kinds).toContain("claim-list:claim-list");
    expect(kinds).toContain("file-excerpt:file:src/auth.ts");
    expect(kinds).toContain("diff:diff:src/auth.ts");
    expect(kinds).toContain("test-output:test-output");
  });

  it("the claim-list leaf content is the canonical claim id list", () => {
    const packet = assemblePrivatePacket(base);
    const leaf = packet.leaves.find((l) => l.kind === "claim-list")!;
    expect(leaf.content).toBe(JSON.stringify(["claim:oauth", "claim:payments"]));
  });

  it("sorts leaves by kind then id for determinism", () => {
    const a = assemblePrivatePacket(base);
    const b = assemblePrivatePacket({ ...base, fileExcerpts: [...base.fileExcerpts].reverse() });
    expect(a.leaves).toEqual(b.leaves);
    expect(a.evidenceRoot).toBe(b.evidenceRoot);
  });

  it("evidenceRoot is merkleRoot over leafHash of every leaf", () => {
    const packet = assemblePrivatePacket(base);
    const expected = mRoot(packet.leaves.map(lHash));
    expect(packet.evidenceRoot).toBe(expected);
  });

  it("applies redactions before computing the root", () => {
    const packet = assemblePrivatePacket({ ...base, redact: ["file:src/pay.ts"] });
    expect(packet.leaves.find((l) => l.id === "file:src/pay.ts")).toBeUndefined();
    expect(packet.evidenceRoot).toBe(mRoot(packet.leaves.map(lHash)));
  });

  it("defaults transport to trusted-transport", () => {
    expect(assemblePrivatePacket(base).transport).toBe("trusted-transport");
  });

  it("only marks sealed when explicitly confirmed", () => {
    expect(assemblePrivatePacket({ ...base, sealedTransportConfirmed: true }).transport).toBe("sealed");
  });
});

describe("renderPacketDisclosure", () => {
  const packet = assemblePrivatePacket({
    publicBundleHash: "0x" + "a".repeat(64),
    snapshotHash: "0x" + "b".repeat(64),
    claimIds: ["claim:oauth"],
    fileExcerpts: [{ path: "src/auth.ts", content: "x" }],
    diffs: [{ path: "src/auth.ts", content: "+x" }],
    testOutput: "ok"
  });

  it("lists every leaf id so the builder sees exactly what is sent", () => {
    const lines = renderPacketDisclosure(packet).join("\n");
    expect(lines).toContain("file:src/auth.ts");
    expect(lines).toContain("diff:src/auth.ts");
    expect(lines).toContain("test-output");
    expect(lines).toContain("claim:oauth");
  });

  it("states the trusted-transport mode in plain words (no silent downgrade)", () => {
    const lines = renderPacketDisclosure(packet).join("\n");
    expect(lines).toContain("TRUSTED-TRANSPORT");
    expect(lines.toLowerCase()).toContain("the relayer can read this packet");
  });

  it("states SEALED when the packet is sealed", () => {
    const sealed = assemblePrivatePacket({
      publicBundleHash: "0x" + "a".repeat(64),
      snapshotHash: "0x" + "b".repeat(64),
      claimIds: ["claim:oauth"],
      sealedTransportConfirmed: true
    });
    const lines = renderPacketDisclosure(sealed).join("\n");
    expect(lines).toContain("SEALED");
    expect(lines.toLowerCase()).toContain("encrypted to the enclave");
  });

  it("includes the evidence root commitment", () => {
    expect(renderPacketDisclosure(packet).join("\n")).toContain(packet.evidenceRoot);
  });
});

import type { ClaimVerdict } from "@vibetrace/schema";

const dims = { relevance: "strong", sufficiency: "proportionate", contradiction: "none" } as const;

function abstained(id: string): ClaimVerdict {
  return {
    claimId: id,
    verdict: "unsupported",
    confidence: 0,
    supportingNodes: [],
    rationale: "no public evidence",
    abstainReason: "insufficient-public-evidence",
    dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
  };
}

function substantiated(id: string, nodes: string[]): ClaimVerdict {
  return {
    claimId: id,
    verdict: "substantiated",
    confidence: 0.7,
    supportingNodes: nodes,
    rationale: "private packet shows the work",
    abstainReason: null,
    dimensions: dims
  };
}

describe("packetCoversClaim", () => {
  const packet = assemblePrivatePacket({
    publicBundleHash: "0x" + "a".repeat(64),
    snapshotHash: "0x" + "b".repeat(64),
    claimIds: ["claim:oauth"],
    fileExcerpts: [{ path: "src/auth.ts", content: "oauth" }]
  });

  it("is true when the verdict cites a file leaf present in the packet", () => {
    expect(packetCoversClaim(packet, substantiated("claim:oauth", ["file:src/auth.ts"]))).toBe(true);
  });

  it("is false when the verdict cites no packet leaf", () => {
    expect(packetCoversClaim(packet, substantiated("claim:oauth", ["trace:nope"]))).toBe(false);
  });

  it("a verdict whose ONLY covering leaf is `claim-list` does NOT cover the claim", () => {
    // `claim-list` is a metadata/commitment leaf present in EVERY packet; a hostile relayer must
    // not be able to pass the evidence gate by citing it (or the other commitment leaves).
    expect(packetCoversClaim(packet, substantiated("claim:oauth", ["claim-list"]))).toBe(false);
    expect(packetCoversClaim(packet, substantiated("claim:oauth", ["public-bundle-hash"]))).toBe(false);
    expect(packetCoversClaim(packet, substantiated("claim:oauth", ["snapshot-hash"]))).toBe(false);
  });

  it("a diff or test-output leaf DOES cover (evidence-bearing kinds)", () => {
    const evidencePacket = assemblePrivatePacket({
      publicBundleHash: "0x" + "a".repeat(64),
      snapshotHash: "0x" + "b".repeat(64),
      claimIds: ["claim:oauth"],
      diffs: [{ path: "src/auth.ts", content: "+oauth" }],
      testOutput: "all green"
    });
    expect(packetCoversClaim(evidencePacket, substantiated("claim:oauth", ["diff:src/auth.ts"]))).toBe(true);
    expect(packetCoversClaim(evidencePacket, substantiated("claim:oauth", ["test-output"]))).toBe(true);
    // commitment leaf still rejected even when evidence leaves exist
    expect(packetCoversClaim(evidencePacket, substantiated("claim:oauth", ["claim-list"]))).toBe(false);
  });
});

describe("upgradeVerdictsWithPacket", () => {
  const packet = assemblePrivatePacket({
    publicBundleHash: "0x" + "a".repeat(64),
    snapshotHash: "0x" + "b".repeat(64),
    claimIds: ["claim:oauth", "claim:payments"],
    fileExcerpts: [{ path: "src/auth.ts", content: "oauth" }]
  });

  it("upgrades an abstained claim that the packet covers and the TEE substantiated", () => {
    const out = upgradeVerdictsWithPacket(
      [abstained("claim:oauth")],
      [substantiated("claim:oauth", ["file:src/auth.ts"])],
      packet
    );
    expect(out[0].verdict).toBe("substantiated");
    expect(out[0].abstainReason).toBeNull();
  });

  it("does NOT upgrade when the packet carries no leaf for that claim", () => {
    const out = upgradeVerdictsWithPacket(
      [abstained("claim:payments")],
      [substantiated("claim:payments", ["file:src/pay.ts"])],
      packet
    );
    expect(out[0].verdict).toBe("unsupported");
    expect(out[0].abstainReason).toBe("insufficient-public-evidence");
  });

  it("does NOT upgrade when the public-only verdict did not abstain for insufficient evidence", () => {
    const inflated: ClaimVerdict = { ...abstained("claim:oauth"), verdict: "inflated", abstainReason: null };
    const out = upgradeVerdictsWithPacket(
      [inflated],
      [substantiated("claim:oauth", ["file:src/auth.ts"])],
      packet
    );
    expect(out[0].verdict).toBe("inflated");
  });

  it("keeps the public-only verdict when the TEE private run did not substantiate", () => {
    const out = upgradeVerdictsWithPacket(
      [abstained("claim:oauth")],
      [{ ...abstained("claim:oauth"), verdict: "inflated", abstainReason: null }],
      packet
    );
    expect(out[0].verdict).toBe("unsupported");
  });
});

import { buildPublicSafeVerifierRun, buildPublicSafeBadges } from "./private-packet";
import type { VerifierRun, EvidenceBadge } from "@vibetrace/schema";

describe("buildPublicSafeVerifierRun", () => {
  const PRIVATE_ROOT = "0x" + "d".repeat(64);
  const rawRun: VerifierRun = {
    verifierId: "vibetrace-attested-adjudicator",
    provider: "0g-compute",
    model: "tee-model",
    requestHash: "0x" + "1".repeat(64),
    responseHash: "0x" + "2".repeat(64),
    outputHash: "0x" + "3".repeat(64),
    createdAt: "2026-06-17T10:00:00.000Z",
    summary: "Evidence hint: SUPER_SECRET_PRIVATE_TOKEN",
    evidenceTier: "private",
    verdicts: [
      {
        claimId: "claim:x",
        verdict: "substantiated",
        confidence: 0.9,
        supportingNodes: ["file:src.ts"],
        rationale: "The packet shows: SUPER_SECRET_PRIVATE_TOKEN",
        abstainReason: null,
        dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
      }
    ]
  };

  it("strips private-evidence text from summary and rationale", () => {
    const safe = buildPublicSafeVerifierRun(rawRun, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(JSON.stringify(safe)).not.toContain("SUPER_SECRET_PRIVATE_TOKEN");
  });

  it("retains identity hashes and tier fields", () => {
    const safe = buildPublicSafeVerifierRun(rawRun, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(safe.verifierId).toBe("vibetrace-attested-adjudicator");
    expect(safe.provider).toBe("0g-compute");
    expect(safe.model).toBe("tee-model");
    expect(safe.requestHash).toBe("0x" + "1".repeat(64));
    expect(safe.evidenceTier).toBe("private");
    expect(safe.privateEvidenceRoot).toBe(PRIVATE_ROOT);
  });

  it("preserves verdicts but replaces each rationale with a fixed neutral string", () => {
    const safe = buildPublicSafeVerifierRun(rawRun, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(safe.verdicts).toHaveLength(1);
    expect(safe.verdicts![0].verdict).toBe("substantiated");
    expect(safe.verdicts![0].rationale).toContain("withheld");
    expect(safe.verdicts![0].rationale).not.toContain("SUPER_SECRET");
  });

  it("strips attestation.chatSignatureLink for private tier (it would retrieve the signed private text)", () => {
    const runWithLink: VerifierRun = {
      ...rawRun,
      attestation: {
        scheme: "0g-teeml",
        attests: "tee-execution",
        providerAddress: "0xProvider",
        signingAddress: "0xSigner",
        signature: "0xsig",
        signedDigest: "0x" + "a".repeat(64),
        responseTextHash: "0x" + "b".repeat(64),
        // signedText (responseHash:chatID) is a hash + opaque id — it SURVIVES (lets consumers verify
        // the digest binding). It is NOT the chatSignatureLink, which retrieves the actual response text.
        signedText: "0x" + "d".repeat(64) + ":chat-abc123",
        processResponseValid: true,
        // This link retrieves the signed RESPONSE text — must NOT survive into the public bundle.
        chatSignatureLink: "https://provider.example/v1/proxy/signature/PLANTED_SIG_SECRET_TOKEN",
        verifiedAt: "2026-06-17T10:00:00.000Z",
        verifiedBy: "vibetrace-relayer"
      }
    };
    const safe = buildPublicSafeVerifierRun(runWithLink, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(safe.attestation?.chatSignatureLink).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("PLANTED_SIG_SECRET_TOKEN");
    // Crypto fields are retained so the attestation stays verifiable without the link.
    expect(safe.attestation?.signature).toBe("0xsig");
    expect(safe.attestation?.signingAddress).toBe("0xSigner");
    // The execution material survives so consumers can re-verify hashMessage(signedText)===signedDigest.
    expect(safe.attestation?.signedText).toBe("0x" + "d".repeat(64) + ":chat-abc123");
    // The honest TEE-execution marker MUST survive sanitization (else consumers wrongly read the
    // private-tier run as not-TEE-attested).
    expect(safe.attestation?.attests).toBe("tee-execution");
  });

  it("explicit whitelist: drops UNKNOWN/injected attestation fields (defense-in-depth)", () => {
    const hostile = {
      ...rawRun,
      attestation: {
        scheme: "0g-teeml",
        providerAddress: "0xP",
        signingAddress: "0xS",
        signature: "0xsig",
        signedDigest: "0x" + "a".repeat(64),
        responseTextHash: "0x" + "b".repeat(64),
        processResponseValid: true,
        verifiedAt: "t",
        verifiedBy: "v",
        privateLeak: "INJECTED_ATTESTATION_SECRET"
      }
    } as unknown as VerifierRun;
    const safe = buildPublicSafeVerifierRun(hostile, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(JSON.stringify(safe)).not.toContain("INJECTED_ATTESTATION_SECRET");
    expect(safe.attestation && "privateLeak" in safe.attestation).toBe(false);
  });

  it("explicit whitelist: drops verdict supportingNodes and nested injected dimensions fields", () => {
    const hostile = {
      ...rawRun,
      verdicts: [
        {
          claimId: "claim:x",
          verdict: "substantiated",
          confidence: 0.9,
          supportingNodes: ["diff:INJECTED_SUPPORT_SECRET"],
          rationale: "ok",
          abstainReason: null,
          dimensions: {
            relevance: "strong",
            sufficiency: "proportionate",
            contradiction: "none",
            privateLeak: "INJECTED_DIM_SECRET"
          }
        }
      ]
    } as unknown as VerifierRun;
    const safe = buildPublicSafeVerifierRun(hostile, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    const json = JSON.stringify(safe);
    expect(json).not.toContain("INJECTED_SUPPORT_SECRET");
    expect(json).not.toContain("INJECTED_DIM_SECRET");
    expect(safe.verdicts![0].supportingNodes).toEqual([]);
    expect("privateLeak" in safe.verdicts![0].dimensions).toBe(false);
  });

  it("drops a verdict whose claimId is not a real public Claim (no arbitrary-claimId injection)", () => {
    const hostile = {
      ...rawRun,
      verdicts: [
        {
          claimId: "claim:INJECTED_SECRET",
          verdict: "substantiated",
          confidence: 0.9,
          supportingNodes: [],
          rationale: "ok",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        }
      ]
    } as unknown as VerifierRun;
    // ALLOWED_CLAIMS only contains "claim:x" — the injected claimId is not a real public Claim.
    const safe = buildPublicSafeVerifierRun(hostile, { privateEvidenceRoot: PRIVATE_ROOT, allowedClaimIds: ALLOWED_CLAIMS });
    expect(JSON.stringify(safe)).not.toContain("INJECTED_SECRET");
    expect(safe.verdicts).toEqual([]);
  });
});

describe("buildPublicSafeBadges", () => {
  it("explicit whitelist: drops unknown fields + non-file supporters, scrubs publicExplanation", () => {
    const hostile = [
      {
        claimId: "claim:x",
        status: "verified",
        confidence: 0.9,
        supportingNodes: ["file:ok.ts", "trace:INJECTED_NODE_SECRET"],
        publicExplanation: "leak: INJECTED_BADGE_SECRET",
        provenance: "structural+attested",
        verdict: "substantiated",
        privateLeak: "INJECTED_BADGE_FIELD_SECRET"
      }
    ] as unknown as EvidenceBadge[];
    const safe = buildPublicSafeBadges(hostile, ALLOWED_CLAIMS);
    const json = JSON.stringify(safe);
    expect(json).not.toContain("INJECTED_BADGE_SECRET");
    expect(json).not.toContain("INJECTED_BADGE_FIELD_SECRET");
    expect(json).not.toContain("INJECTED_NODE_SECRET");
    expect(safe[0].supportingNodes).toEqual(["file:ok.ts"]);
    expect("privateLeak" in safe[0]).toBe(false);
  });
});
