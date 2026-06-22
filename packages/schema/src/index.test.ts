import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalStringify,
  createPublicLedgerBundle,
  hashPublicLedgerBundle,
  publicLedgerHashPayload,
  redactTraceSpanForPublic,
  validateTraceSpans,
  type ClaimVerdict,
  type PublicLedgerBundle,
  type TeeAttestation,
  type VerifierRun,
  type VerifyAgainst0G
} from "./index";

describe("canonical serialization", () => {
  it("hashes equivalent objects deterministically", () => {
    const left = { b: 2, a: { z: true, y: ["x", "y"] } };
    const right = { a: { y: ["x", "y"], z: true }, b: 2 };

    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(canonicalHash(left)).toMatch(/^0x[a-f0-9]{64}$/);
    expect(canonicalHash(left)).toBe(canonicalHash(right));
  });
});

describe("trace span validation", () => {
  it("accepts generic trace spans and rejects raw prompt fields", () => {
    const valid = [
      {
        spanId: "span-1",
        tool: "codex",
        model: "gpt-5",
        startedAt: "2026-06-17T10:00:00.000Z",
        endedAt: "2026-06-17T10:04:00.000Z",
        promptHash: "0x" + "a".repeat(64),
        responseHash: "0x" + "b".repeat(64),
        filesMentioned: ["src/storage.ts"],
        artifactsProduced: ["src/storage.ts"],
        metadata: { session: "demo" }
      }
    ];

    expect(validateTraceSpans(valid)).toHaveLength(1);
    expect(() =>
      validateTraceSpans([{ ...valid[0], rawPrompt: "secret prompt" }])
    ).toThrow(/rawPrompt/);
  });
});

describe("public redaction", () => {
  it("removes prompt and response excerpts unless they are explicitly public", () => {
    const redacted = redactTraceSpanForPublic({
      spanId: "span-1",
      tool: "claude-code",
      model: "claude-sonnet",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T10:04:00.000Z",
      promptHash: "0x" + "a".repeat(64),
      responseHash: "0x" + "b".repeat(64),
      promptExcerpt: "private implementation detail",
      responseExcerpt: "private generated code",
      filesMentioned: ["src/index.ts"],
      artifactsProduced: ["src/index.ts"],
      metadata: { keep: "safe" }
    });

    expect(redacted).not.toHaveProperty("promptExcerpt");
    expect(redacted).not.toHaveProperty("responseExcerpt");
    expect(redacted.promptHash).toMatch(/^0x/);
  });

  it("creates a public bundle whose hash is derived after redaction", () => {
    const bundle = createPublicLedgerBundle({
      manifest: {
        schemaVersion: "vibetrace.v1",
        project: { name: "Demo" },
        repo: { root: "/repo", commit: "abc123" },
        createdAt: "2026-06-17T10:00:00.000Z",
        snapshotRoot: "0x" + "1".repeat(64),
        traceRoot: "0x" + "2".repeat(64),
        graphRoot: "0x" + "3".repeat(64),
        publicBundleHash: "pending",
        anchors: []
      },
      publicGraph: {
        nodes: [],
        edges: [],
        redactionPolicy: "private-by-default",
        canonicalHash: "0x" + "4".repeat(64)
      },
      verifierSummary: {
        verifierId: "local",
        provider: "local",
        model: "deterministic",
        requestHash: "0x" + "5".repeat(64),
        responseHash: "0x" + "6".repeat(64),
        outputHash: "0x" + "7".repeat(64),
        createdAt: "2026-06-17T10:00:00.000Z",
        summary: "No private text here",
        evidenceTier: "public-only"
      },
      evidenceBadges: [],
      storageAnchor: {
        kind: "storage",
        provider: "0g-dev",
        uri: "0g://local/demo",
        rootHash: "0x" + "8".repeat(64),
        createdAt: "2026-06-17T10:00:00.000Z"
      },
      chainAnchor: {
        kind: "chain",
        provider: "0g-dev",
        txHash: "0x" + "9".repeat(64),
        chainId: 16602,
        manifestHash: "0x" + "a".repeat(64),
        createdAt: "2026-06-17T10:00:00.000Z"
      }
    });

    expect(bundle.manifest.publicBundleHash).toBe(hashPublicLedgerBundle(bundle));
  });
});

describe("ClaimVerdict", () => {
  it("represents a per-claim adjudication verdict with advisory confidence and audit-only supporting nodes", () => {
    const verdict: ClaimVerdict = {
      claimId: "claim:oauth-login",
      verdict: "inflated",
      confidence: 0.42,
      supportingNodes: ["trace:abc", "file:auth/oauth.ts@abc123"],
      rationale: "linked to auth/oauth.ts but only a 2-line change; magnitude oversold",
      abstainReason: null,
      dimensions: {
        relevance: "strong",
        sufficiency: "thin",
        contradiction: "none"
      }
    };

    expect(verdict.verdict).toBe("inflated");
    expect(verdict.confidence).toBe(0.42);
    // supportingNodes is DISPLAY/AUDIT ONLY and may include trace: ids
    // (the only graph prefixes are trace:/file:/artifact:/commit: — never span:)
    expect(verdict.supportingNodes).toContain("trace:abc");
    expect(canonicalHash(verdict)).toMatch(/^0x[a-f0-9]{64}$/);
  });
});

describe("VerifierRun attestation fields", () => {
  it("carries an attestation, verdicts, evidenceTier, privateEvidenceRoot and verdictRoot", () => {
    const run: VerifierRun = {
      verifierId: "0g-compute",
      provider: "0g-compute",
      model: "tee-judge",
      requestHash: "0x" + "1".repeat(64),
      responseHash: "0x" + "2".repeat(64),
      outputHash: "0x" + "3".repeat(64),
      createdAt: "2026-06-19T10:00:00.000Z",
      summary: "adjudicated 3 claims",
      evidenceTier: "private",
      privateEvidenceRoot: "0x" + "4".repeat(64),
      verdictRoot: "0x" + "5".repeat(64),
      verdicts: [
        {
          claimId: "claim:oauth-login",
          verdict: "substantiated",
          confidence: 0.8,
          supportingNodes: ["file:auth/oauth.ts@abc123"],
          rationale: "auth/oauth.ts implements the claimed flow",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        }
      ],
      attestation: {
        scheme: "0g-teeml",
        attests: "tee-execution",
        providerAddress: "0xProvider000000000000000000000000000000aa",
        signingAddress: "0xSigner0000000000000000000000000000000bb",
        signature: "0x" + "c".repeat(130),
        signedDigest: "0x" + "d".repeat(64),
        responseTextHash: "0x" + "e".repeat(64),
        processResponseValid: true,
        verifiedAt: "2026-06-19T10:00:00.000Z",
        verifiedBy: "vibetrace-relayer"
      }
    };

    expect(run.evidenceTier).toBe("private");
    expect(run.verdicts?.[0].verdict).toBe("substantiated");
    expect(run.attestation?.scheme).toBe("0g-teeml");
    expect(run.verdictRoot).toBe("0x" + "5".repeat(64));
  });

  it("supports a minimal public-only run with no attestation", () => {
    const run: VerifierRun = {
      verifierId: "local",
      provider: "local",
      model: "deterministic",
      requestHash: "0x" + "5".repeat(64),
      responseHash: "0x" + "6".repeat(64),
      outputHash: "0x" + "7".repeat(64),
      createdAt: "2026-06-17T10:00:00.000Z",
      summary: "No private text here",
      evidenceTier: "public-only"
    };
    expect(run.attestation).toBeUndefined();
    expect(run.verdicts).toBeUndefined();
    expect(run.evidenceTier).toBe("public-only");
  });
});

describe("EvidenceBadge provenance/verdict", () => {
  it("optionally records provenance and the merged verdict word", () => {
    const badge: import("./index").EvidenceBadge = {
      claimId: "claim:oauth-login",
      status: "partial",
      confidence: 0.4,
      supportingNodes: ["file:auth/oauth.ts@abc123"],
      publicExplanation: "linked but oversold",
      provenance: "structural+attested",
      verdict: "inflated"
    };
    expect(badge.provenance).toBe("structural+attested");
    expect(badge.verdict).toBe("inflated");
    // supportingNodes stays file-only (scoring guard, spec §6 invariant 4)
    expect(badge.supportingNodes.every((id) => id.startsWith("file:"))).toBe(true);
  });

  it("allows a structural-only badge with no verdict", () => {
    const badge: import("./index").EvidenceBadge = {
      claimId: "claim:oauth-login",
      status: "unsupported",
      confidence: 0,
      supportingNodes: [],
      publicExplanation: "no supports edge",
      provenance: "structural-only"
    };
    expect(badge.provenance).toBe("structural-only");
    expect(badge.verdict).toBeUndefined();
  });
});

describe("VerifyAgainst0G", () => {
  it("captures storage + chain read-back results", () => {
    const v: VerifyAgainst0G = {
      storage: {
        rootHash: "0x" + "1".repeat(64),
        recomputedHash: "0x" + "1".repeat(64),
        matches: true
      },
      chain: {
        txHash: "0x" + "2".repeat(64),
        calldataManifestHash: "0x" + "3".repeat(64),
        expectedManifestHash: "0x" + "3".repeat(64),
        matches: true,
        readAt: "2026-06-19T10:00:00.000Z"
      }
    };
    expect(v.storage.matches).toBe(true);
    expect(v.chain.matches).toBe(true);
    expect(canonicalHash(v)).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("carries an optional signer leg whose matches requires acknowledged + quote-verified + address equality", () => {
    const signer = (over: Partial<NonNullable<VerifyAgainst0G["signer"]>>) => ({
      providerAddress: "0xa48f",
      expectedSigner: "0x83df",
      onChainSigner: "0x83df",
      acknowledgedOnChain: true,
      quoteVerified: true,
      matches: true,
      ...over
    });
    const v: VerifyAgainst0G = {
      storage: { rootHash: "0x1", recomputedHash: "0x1", matches: true },
      chain: { txHash: "0x2", calldataManifestHash: "0x3", expectedManifestHash: "0x3", matches: true, readAt: "t" },
      signer: signer({})
    };
    expect(v.signer?.matches).toBe(true);
    // The matches semantics callers must honor: matches is the IDENTITY binding (acknowledged on-chain
    // signer == expectedSigner). A null/mismatched signer or un-acknowledged signer ⇒ matches false.
    const fails = [
      signer({ onChainSigner: null, matches: false }),
      signer({ onChainSigner: "0xDEAD", matches: false }),
      signer({ acknowledgedOnChain: false, matches: false })
    ];
    for (const s of fails) expect(s.matches).toBe(false);
    // quoteVerified is reported but is NOT part of matches — a best-effort live quote miss still matches.
    expect(signer({ quoteVerified: false, matches: true }).matches).toBe(true);
    expect(canonicalHash(v)).toMatch(/^0x[a-f0-9]{64}$/);
  });
});

describe("TeeAttestation", () => {
  it("keeps signedDigest (keccak) and responseTextHash (sha256) as distinct fields", () => {
    const attestation: TeeAttestation = {
      scheme: "0g-teeml",
      attests: "tee-execution",
      providerAddress: "0xProvider000000000000000000000000000000aa",
      signingAddress: "0xSigner0000000000000000000000000000000bb",
      signature: "0x" + "c".repeat(130),
      signedDigest: "0x" + "d".repeat(64),
      responseTextHash: "0x" + "e".repeat(64),
      processResponseValid: true,
      teeType: "TDX",
      composeVerificationPassed: true,
      signerAllMatch: true,
      attestationQuoteUri: "0g://quote-root",
      quoteHash: "0x" + "f".repeat(64),
      raDownloadLink: "https://example.invalid/ra",
      chatSignatureLink: "https://example.invalid/sig",
      verifiedAt: "2026-06-19T10:00:00.000Z",
      verifiedBy: "vibetrace-relayer"
    };

    expect(attestation.scheme).toBe("0g-teeml");
    expect(attestation.processResponseValid).toBe(true);
    // The two hashes are DIFFERENT functions over the same signed text.
    expect(attestation.signedDigest).not.toBe(attestation.responseTextHash);
    expect(canonicalHash(attestation)).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("allows the optional verifyService-summary fields to be omitted", () => {
    const minimal: TeeAttestation = {
      scheme: "0g-teeml",
      attests: "tee-execution",
      providerAddress: "0xProvider000000000000000000000000000000aa",
      signingAddress: "0xSigner0000000000000000000000000000000bb",
      signature: "0x" + "c".repeat(130),
      signedDigest: "0x" + "d".repeat(64),
      responseTextHash: "0x" + "e".repeat(64),
      processResponseValid: false,
      verifiedAt: "2026-06-19T10:00:00.000Z",
      verifiedBy: "vibetrace-relayer"
    };
    expect(minimal.teeType).toBeUndefined();
    expect(minimal.processResponseValid).toBe(false);
  });

  it("requires `attests: \"tee-execution\"` — the signature attests EXECUTION + a response-hash, NOT the verdict content", () => {
    const att: TeeAttestation = {
      scheme: "0g-teeml",
      attests: "tee-execution",
      providerAddress: "0xProvider000000000000000000000000000000aa",
      signingAddress: "0xSigner0000000000000000000000000000000bb",
      signature: "0x" + "c".repeat(130),
      signedDigest: "0x" + "d".repeat(64),
      responseTextHash: "0x" + "e".repeat(64),
      processResponseValid: true,
      verifiedAt: "2026-06-19T10:00:00.000Z",
      verifiedBy: "vibetrace-relayer"
    };
    // `attests` is a literal that pins what the signature proves: the TEE signer named by the attestation
    // EXECUTED inference for this chatID and signed `responseHash:chatID`. It does NOT bind the verdict JSON
    // (and VibeTrace does not itself verify the signer against an on-chain registry).
    expect(att.attests).toBe("tee-execution");
    // Consumers MUST tolerate legacy data missing the field (treat as not-TEE-attested), so reading it
    // off an untyped legacy object yields undefined rather than throwing.
    const legacy = { ...att } as Record<string, unknown>;
    delete legacy.attests;
    expect((legacy as { attests?: string }).attests).toBeUndefined();
  });
});

describe("tamper-hash coverage invariants", () => {
  const baseAttestedBundle = (): PublicLedgerBundle =>
    createPublicLedgerBundle({
      manifest: {
        schemaVersion: "vibetrace.v1",
        project: { name: "Demo" },
        repo: { root: "/repo", commit: "abc123" },
        createdAt: "2026-06-19T10:00:00.000Z",
        snapshotRoot: "0x" + "1".repeat(64),
        traceRoot: "0x" + "2".repeat(64),
        graphRoot: "0x" + "3".repeat(64),
        publicBundleHash: "pending",
        anchors: []
      },
      publicGraph: {
        nodes: [],
        edges: [],
        redactionPolicy: "private-by-default",
        canonicalHash: "0x" + "4".repeat(64)
      },
      verifierSummary: {
        verifierId: "0g-compute",
        provider: "0g-compute",
        model: "tee-judge",
        requestHash: "0x" + "5".repeat(64),
        responseHash: "0x" + "6".repeat(64),
        outputHash: "0x" + "7".repeat(64),
        createdAt: "2026-06-19T10:00:00.000Z",
        summary: "adjudicated 1 claim",
        evidenceTier: "public-only",
        verdictRoot: "0x" + "a".repeat(64),
        verdicts: [
          {
            claimId: "claim:oauth-login",
            verdict: "substantiated",
            confidence: 0.8,
            supportingNodes: ["file:auth/oauth.ts@abc123"],
            rationale: "auth/oauth.ts implements the claimed flow",
            abstainReason: null,
            dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
          }
        ],
        attestation: {
          scheme: "0g-teeml",
          attests: "tee-execution",
          providerAddress: "0xProvider000000000000000000000000000000aa",
          signingAddress: "0xSigner0000000000000000000000000000000bb",
          signature: "0x" + "c".repeat(130),
          signedDigest: "0x" + "d".repeat(64),
          responseTextHash: "0x" + "e".repeat(64),
          processResponseValid: true,
          verifiedAt: "2026-06-19T10:00:00.000Z",
          verifiedBy: "vibetrace-relayer"
        }
      },
      evidenceBadges: [],
      storageAnchor: {
        kind: "storage",
        provider: "0g-dev",
        uri: "0g://local/demo",
        rootHash: "0x" + "8".repeat(64),
        createdAt: "2026-06-19T10:00:00.000Z"
      },
      chainAnchor: {
        kind: "chain",
        provider: "0g-dev",
        txHash: "0x" + "9".repeat(64),
        chainId: 16602,
        manifestHash: "0x" + "a".repeat(64),
        createdAt: "2026-06-19T10:00:00.000Z"
      }
    });

  it("round-trips: recorded hash equals a fresh hashPublicLedgerBundle", () => {
    const bundle = baseAttestedBundle();
    expect(bundle.manifest.publicBundleHash).toBe(hashPublicLedgerBundle(bundle));
  });

  it("includes attestation under the tamper hash", () => {
    const bundle = baseAttestedBundle();
    const original = canonicalHash(publicLedgerHashPayload(bundle));
    const tampered: PublicLedgerBundle = {
      ...bundle,
      verifierSummary: {
        ...bundle.verifierSummary,
        attestation: {
          ...bundle.verifierSummary.attestation!,
          signature: "0x" + "0".repeat(130)
        }
      }
    };
    expect(canonicalHash(publicLedgerHashPayload(tampered))).not.toBe(original);
  });

  it("includes verdicts under the tamper hash", () => {
    const bundle = baseAttestedBundle();
    const original = canonicalHash(publicLedgerHashPayload(bundle));
    const tampered: PublicLedgerBundle = {
      ...bundle,
      verifierSummary: {
        ...bundle.verifierSummary,
        verdicts: [
          { ...bundle.verifierSummary.verdicts![0], verdict: "inflated" }
        ]
      }
    };
    expect(canonicalHash(publicLedgerHashPayload(tampered))).not.toBe(original);
  });

  it("includes verdictRoot under the tamper hash", () => {
    const bundle = baseAttestedBundle();
    const original = canonicalHash(publicLedgerHashPayload(bundle));
    const tampered: PublicLedgerBundle = {
      ...bundle,
      verifierSummary: { ...bundle.verifierSummary, verdictRoot: "0x" + "b".repeat(64) }
    };
    expect(canonicalHash(publicLedgerHashPayload(tampered))).not.toBe(original);
  });

  it("EXCLUDES verifyAgainst0G from the tamper hash", () => {
    const bundle = baseAttestedBundle();
    const original = canonicalHash(publicLedgerHashPayload(bundle));
    const withReadBack: PublicLedgerBundle = {
      ...bundle,
      verifyAgainst0G: {
        storage: { rootHash: "0x" + "1".repeat(64), recomputedHash: "0x" + "1".repeat(64), matches: true },
        chain: {
          txHash: "0x" + "2".repeat(64),
          calldataManifestHash: "0x" + "3".repeat(64),
          expectedManifestHash: "0x" + "3".repeat(64),
          matches: true,
          readAt: "2026-06-19T10:00:00.000Z"
        }
      }
    };
    // Adding the read-back must NOT change the bundle hash.
    expect(canonicalHash(publicLedgerHashPayload(withReadBack))).toBe(original);
    // ...and createPublicLedgerBundle must compute the same publicBundleHash.
    expect(createPublicLedgerBundle(withReadBack).manifest.publicBundleHash).toBe(
      bundle.manifest.publicBundleHash
    );
  });
});
