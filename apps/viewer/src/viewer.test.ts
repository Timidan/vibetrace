import { describe, expect, it, vi } from "vitest";
import { buildArtifactGraph } from "@vibetrace/graph";
import { runLocalVerifier } from "@vibetrace/verifier";
import { scoreBundle } from "@vibetrace/score";
import {
  createPublicLedgerBundle,
  hashPublicLedgerBundle,
  type ClaimInput,
  type CommitSnapshotData,
  type PublicLedgerBundle,
  type TraceSpan
} from "@vibetrace/schema";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderBundle,
  verifyBundleHash,
  renderLiveMarquee,
  renderMarqueeBar,
  relativeTime,
  relativeTimeFromIso,
  escapeHtml
} from "./viewer";
import { renderLeaderboard } from "./leaderboard";
import { renderLanding, renderNav } from "./landing";
import type { RegistrySummary } from "./registry";
import {
  renderBadgeForId,
  badgeForEntry,
  flatBadgeSvg,
  mutedBadgeSvg,
  stampBadgeSvg,
  tierBadgeColors,
  escapeXml,
  type StoredEntry
} from "../vite-registry-plugin";
// registry-core is the shared core both the Vite plugin and the standalone
// server.ts import; exercise its async handlers directly here.
import {
  createStore,
  deriveSummary,
  handleRegistry,
  handleBundle,
  handleBadge,
  handleSubmit,
  readLimitedRequestBody,
  writeJsonFileAtomic,
  type RegistryLimits,
  type RegistryStore
} from "../registry-core";
import { Wallet, hashMessage } from "ethers";

/* ── Recovering TEE-execution attestation material. The TEE/seal display gate
 *    requires recoverAddress(signedDigest, signature) === signingAddress, not just
 *    shape. A throwaway enclave signs a fixed exec string at module load (top-level
 *    await) so the SYNCHRONOUS attestedBundle() helpers can mint a REAL recovering
 *    attestation. NOT a real 0G key — mirrors relayer-client.test.ts. */
const TEST_ENCLAVE = new Wallet("0x" + "3".repeat(64));
const TEST_SIGNED_EXEC = `0x${"a".repeat(64)}:chat-viewer-test`;
const TEST_SIGNATURE = await TEST_ENCLAVE.signMessage(TEST_SIGNED_EXEC);
const TEST_SIGNED_DIGEST = hashMessage(TEST_SIGNED_EXEC);
const TEST_SIGNING_ADDRESS = TEST_ENCLAVE.address;

/* ── Real seed fixture: a committed, real attested+anchored published bundle (no fabricated
   data). Lives in apps/viewer/test-fixtures so the suite is clone-clean — it never reads the
   gitignored runtime .vibetrace/public, which is empty on a fresh checkout. ── */

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../test-fixtures");

function loadSeedBundles(): PublicLedgerBundle[] {
  let files: string[];
  try {
    files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SEED_DIR, f), "utf8")) as PublicLedgerBundle);
}

/** Derive a RegistrySummary from a real bundle, mirroring the server contract. */
function summarize(bundle: PublicLedgerBundle, submittedAt: string): RegistrySummary {
  const score = scoreBundle(bundle);
  const bundleHash = hashPublicLedgerBundle(bundle);
  const nodes = bundle.publicGraph.nodes;
  const seen = new Set<string>();
  const tools: { tool: string; model: string }[] = [];
  for (const n of nodes) {
    if (n.type !== "TraceSpan") continue;
    const data = (n.data ?? {}) as Record<string, unknown>;
    const tool = String(data.tool ?? "tool");
    const model = String(data.model ?? "model");
    const key = `${tool}·${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({ tool, model });
  }
  return {
    id: bundleHash.replace(/^0x/, ""),
    project: bundle.manifest.project?.name ?? "Untitled",
    repo: bundle.manifest.repo.commit || bundle.manifest.repo.root,
    tools,
    vibeScore: score.vibeScore,
    tier: score.tier,
    tierLabel: score.tierLabel,
    seal: score.integrity.seal,
    anchored: score.integrity.anchored,
    scoreVersion: score.scoreVersion,
    buildScore: score.buildScore,
    buildTier: score.buildTier,
    buildTierLabel: score.buildTierLabel,
    proofLabel: score.proof.label,
    proofRank: score.proof.rank,
    trustWeightedScore: score.trustWeightedScore,
    fileCount: nodes.filter((n) => n.type === "FileVersion").length,
    verifiedClaims: bundle.evidenceBadges.filter((b) => b.status === "verified").length,
    teeVerified: false,
    attestedVerdict: null,
    substantiatedClaims: 0,
    submittedAt,
    bundleHash
  };
}

const hx = (seed: string) => "0x" + seed.repeat(64).slice(0, 64);

const baseBundle = {
  manifest: {
    schemaVersion: "vibetrace.v1",
    project: { name: "Demo" },
    repo: { root: "/repo", commit: "abc123", branch: "main" },
    createdAt: "2026-06-17T10:00:00.000Z",
    snapshotRoot: hx("1"),
    traceRoot: hx("2"),
    graphRoot: hx("3"),
    publicBundleHash: "pending",
    anchors: []
  },
  publicGraph: {
    nodes: [
      {
        id: "commit:abc123",
        type: "CommitSnapshot",
        label: "abc123",
        data: { createdAt: "2026-06-17T10:00:00.000Z" }
      }
    ],
    edges: [],
    redactionPolicy: "private-by-default",
    canonicalHash: hx("4")
  },
  verifierSummary: {
    verifierId: "local",
    provider: "0g-dev",
    model: "deterministic-lineage-verifier",
    requestHash: hx("5"),
    responseHash: hx("6"),
    outputHash: hx("7"),
    createdAt: "2026-06-17T10:00:00.000Z",
    summary: "Verified",
    evidenceTier: "public-only" as const
  },
  evidenceBadges: [
    {
      claimId: "claim:ai-build",
      status: "verified",
      confidence: 0.9,
      supportingNodes: [],
      publicExplanation: "Artifact supports this claim."
    }
  ],
  storageAnchor: {
    kind: "storage",
    provider: "0g-dev",
    uri: "0g://local/demo",
    rootHash: hx("8"),
    createdAt: "2026-06-17T10:00:00.000Z"
  },
  chainAnchor: {
    kind: "chain",
    provider: "0g-dev",
    txHash: hx("9"),
    chainId: 16602,
    manifestHash: "pending",
    createdAt: "2026-06-17T10:00:00.000Z"
  }
} as unknown as PublicLedgerBundle;

/**
 * Build a fully anchored, high-coverage bundle through the real pipeline
 * packages so the integrity + coverage gates pass (anchored-verified seal).
 */
function anchoredBundle(): PublicLedgerBundle {
  const COMMIT = "abc123";
  const files = [
    { path: "src/index.ts", size: 284, hash: hx("a") },
    { path: "README.md", size: 1186, hash: hx("b") }
  ];
  const traces: TraceSpan[] = [
    {
      spanId: "span-build-1",
      tool: "codex",
      model: "gpt-5",
      startedAt: "2026-06-17T09:50:00.000Z",
      endedAt: "2026-06-17T09:58:00.000Z",
      promptHash: hx("c"),
      responseHash: hx("d"),
      filesMentioned: [],
      artifactsProduced: ["src/index.ts", "README.md"],
      metadata: {}
    }
  ];
  const snapshots: CommitSnapshotData[] = [
    {
      snapshotId: `snapshot:${COMMIT}`,
      commit: COMMIT,
      branch: "no-git",
      createdAt: "2026-06-17T10:00:00.000Z",
      files,
      packageMetadata: { name: "demo" }
    }
  ];
  const claims: ClaimInput[] = [
    { claimId: "ai-build", text: "Includes AI-assisted build trace evidence", selectors: ["src/index.ts"] }
  ];

  const graph = buildArtifactGraph({ traces, snapshots, claims });
  const verifierSummary = {
    verifierId: "0g-router-verifier",
    provider: "0g-router",
    model: "deterministic-lineage-verifier",
    requestHash: hx("5"),
    responseHash: hx("6"),
    outputHash: hx("7"),
    createdAt: "2026-06-17T10:01:00.000Z",
    summary: "VibeTrace linked 1 AI trace span to 2 file versions and verified 1 public claim.",
    evidenceTier: "public-only" as const
  };
  const evidenceBadges = [
    {
      claimId: "claim:ai-build",
      status: "verified" as const,
      confidence: 0.9,
      supportingNodes: ["file:src/index.ts@abc123"],
      publicExplanation: "1 public artifact supports this claim."
    }
  ];

  const base = createPublicLedgerBundle({
    manifest: {
      schemaVersion: "vibetrace.v1",
      project: { name: "Demo" },
      repo: { root: "/repo", commit: COMMIT, branch: "no-git" },
      createdAt: "2026-06-17T10:00:00.000Z",
      snapshotRoot: hx("1"),
      traceRoot: hx("2"),
      graphRoot: graph.canonicalHash,
      publicBundleHash: "pending",
      anchors: []
    },
    publicGraph: graph,
    verifierSummary,
    evidenceBadges,
    storageAnchor: { kind: "storage", provider: "0g-storage", uri: "0g://local/demo", rootHash: hx("8"), createdAt: "2026-06-17T10:00:00.000Z" },
    chainAnchor: { kind: "chain", provider: "0g-chain", txHash: hx("9"), chainId: 16602, manifestHash: "pending", createdAt: "2026-06-17T10:00:00.000Z" }
  });
  const manifestHash = hashPublicLedgerBundle(base);
  return {
    ...base,
    manifest: { ...base.manifest, publicBundleHash: manifestHash },
    chainAnchor: { ...base.chainAnchor, manifestHash }
  };
}

type ChainManifestState = "match" | "pending" | "missing" | "mismatch";

function bundleWithChainState(provider: string, state: ChainManifestState): PublicLedgerBundle {
  const source = anchoredBundle();
  const pending = {
    ...source,
    manifest: { ...source.manifest, publicBundleHash: "pending" },
    // This helper exercises the CHAIN/STORAGE provider under test, not verifier
    // independence. The verifier here is self-verified (a bare provider string is no
    // longer independent — that now needs a recovering 0g-compute attestation), so
    // these cases assert "anchored" facts, not "anchored-verified".
    verifierSummary: { ...source.verifierSummary, provider: "0g-router" },
    storageAnchor: { ...source.storageAnchor, provider },
    chainAnchor: { ...source.chainAnchor, provider, manifestHash: "pending" }
  } as PublicLedgerBundle;
  const manifestHash = hashPublicLedgerBundle(pending);
  const manifest = { ...pending.manifest, publicBundleHash: manifestHash };

  if (state === "missing") {
    const chainAnchor = { ...pending.chainAnchor } as Record<string, unknown>;
    delete chainAnchor.manifestHash;
    return { ...pending, manifest, chainAnchor } as unknown as PublicLedgerBundle;
  }

  const chainManifestHash = state === "match" ? manifestHash : state === "mismatch" ? hx("f") : "pending";
  return {
    ...pending,
    manifest,
    chainAnchor: { ...pending.chainAnchor, manifestHash: chainManifestHash }
  } as PublicLedgerBundle;
}

describe("viewer verification (still valid)", () => {
  it("marks bundles valid only when the recomputed public hash matches the manifest", () => {
    const result = verifyBundleHash(baseBundle);
    expect(result.valid).toBe(true);
    expect(result.computedHash).toBe(result.expectedHash);

    const invalid = verifyBundleHash({
      ...baseBundle,
      manifest: { ...baseBundle.manifest, publicBundleHash: hx("f") }
    });
    expect(invalid.valid).toBe(false);
  });

  it("does not treat pending or missing chain manifests as on-chain verified", () => {
    const pending = verifyBundleHash(bundleWithChainState("0g", "pending"));
    expect(pending.valid).toBe(true);
    expect(pending.chainAnchorValid).toBe(false);

    const missing = verifyBundleHash(bundleWithChainState("0g", "missing"));
    expect(missing.valid).toBe(true);
    expect(missing.chainAnchorValid).toBe(false);
  });

  it("does not treat 0g-dev provider variants as on-chain verified", () => {
    const result = verifyBundleHash(bundleWithChainState("0G-DEV", "match"));
    expect(result.valid).toBe(true);
    expect(result.chainAnchorValid).toBe(false);
  });
});

describe("renderBundle — story-first VibeTrace view", () => {
  it("renders the headline and project name hook", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("Built with AI.");
    expect(html).toContain("Provably.");
    expect(html).toContain("VibeTrace");
  });

  it("renders the VibeScore number and tier badge (demoted below the fold)", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    expect(score.buildScore).toBeGreaterThan(0);
    // The Build Score is demoted below the fold but still present on the page.
    expect(html).toContain("Build Score");
    expect(html).toContain(String(score.buildScore));
    expect(html).toContain(score.buildTier);
    expect(html).toContain(score.buildTierLabel);
    // …and it is NOT the lead object: the flex line is.
    expect(html.indexOf("Yes, I vibe-coded this. Receipts attached.")).toBeLessThan(html.indexOf("Build Score"));
  });

  it("stamps AUTHENTICATED for an anchored + verified bundle", () => {
    // anchored-verified requires REAL independence now: a 0g-compute run carrying a recovering
    // TEE-execution attestation AND a live on-chain signer leg (recovery alone is only
    // execution-attested — a self-keypair forger would pass it).
    const bundle = withSignerLeg(attestedBundle());
    const score = scoreBundle(bundle);
    expect(score.integrity.seal).toBe("anchored-verified");
    const html = renderBundle(bundle, score);
    // ANCHORED ON 0G is now a mono stat-row fact, not a spinning stamp word.
    expect(html).toContain("ANCHORED ON 0G");
    expect(html).not.toContain("MISMATCH");
    expect(html).not.toContain("AUTHEN-");
  });

  it("shows the supporting summary line with file count and verified claim count", () => {
    const bundle = bundleWithChainState("0g-chain", "match");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // the mono stat row (receipts card) mentions file count and "ANCHORED ON 0G"
    expect(html).toMatch(/\d+ files traced/);
    expect(html).toContain("ANCHORED ON 0G");
  });

  it("renders trace tool and model in the story beats (How it was built)", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("How it was built");
    expect(html).toContain("codex");
    expect(html).toContain("gpt-5");
  });

  it("shows the verified claim count in the summary line", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // the receipts card stat row reflects the SUBSTANTIATED count from verdicts
    // (structural-only anchoredBundle has 0 verdicts → 0 SUBSTANTIATED · 0 FLAGGED)
    expect(html).toContain("SUBSTANTIATED");
    expect(html).toContain("FLAGGED");
  });

  it("shows produced file paths in the story beats", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("src/index.ts");
    expect(html).not.toContain("promptExcerpt");
    expect(html).not.toContain("responseExcerpt");
  });

  it("renders the compact proof strip with fingerprint and anchor match indicator", () => {
    const bundle = bundleWithChainState("0g-chain", "match");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("Bundle Fingerprint");
    expect(html).toContain("ANCHORED ON 0G");
    expect(html).toContain("matches on-chain anchor");
  });

  it("labels matching 0g-dev anchors as DEV ANCHOR without on-chain match copy", () => {
    const bundle = bundleWithChainState("0g-dev", "match");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    expect(html).toContain("DEV ANCHOR (0g-dev)");
    expect(html).not.toContain("ANCHORED ON 0G");
    expect(html).not.toContain("matches on-chain anchor");
    expect(html).not.toContain("anchored on-chain");
    expect(html).not.toContain("anchored on 0G");
  });

  it("labels provider-normalized 0g-dev anchors as DEV ANCHOR in the seal and proof strip", () => {
    const bundle = bundleWithChainState("0G-DEV", "match");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    // A 0g-dev anchor is NEVER on-chain: honest seal is self-published, never anchored-verified.
    expect(score.integrity.seal).toBe("self-published");
    expect(html).toContain("DEV ANCHOR (0g-dev)");
    expect(html).not.toContain("ANCHORED ON 0G");
    expect(html).not.toContain("matches on-chain anchor");
    expect(html).not.toContain("AUTHEN-");
  });

  it("does not show on-chain match copy for pending chain manifests", () => {
    const bundle = bundleWithChainState("0g", "pending");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    expect(html).toContain("ANCHOR PENDING");
    expect(html).not.toContain("matches on-chain anchor");
    expect(html).not.toContain("ANCHORED ON 0G");
  });

  it("does not show on-chain match copy for missing chain manifests", () => {
    const bundle = bundleWithChainState("0g", "missing");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    expect(html).toContain("CHAIN MANIFEST MISSING");
    expect(html).not.toContain("matches on-chain anchor");
    expect(html).not.toContain("ANCHORED ON 0G");
  });

  it("shows a MISMATCH stamp when the bundle hash does not match the anchor", () => {
    const broken = bundleWithChainState("0g", "mismatch");
    const score = scoreBundle(broken);
    const html = renderBundle(broken, score);
    expect(html).toContain("MISMATCH");
    expect(html).not.toContain("AUTHEN-");
  });

  it("stamps AUTHENTICATED + MATCHES for an anchored-but-self-verified on-chain bundle", () => {
    const bundle = anchoredBundle();
    const reverified = createPublicLedgerBundle({
      manifest: { ...bundle.manifest, publicBundleHash: "pending" },
      publicGraph: bundle.publicGraph,
      verifierSummary: { ...bundle.verifierSummary, provider: "0g-dev", model: "gpt-5" },
      evidenceBadges: bundle.evidenceBadges,
      storageAnchor: { ...bundle.storageAnchor, provider: "0g-storage" },
      chainAnchor: { ...bundle.chainAnchor, provider: "0g-chain", manifestHash: "pending" }
    });
    const manifestHash = hashPublicLedgerBundle(reverified);
    const anchored = {
      ...reverified,
      manifest: { ...reverified.manifest, publicBundleHash: manifestHash },
      chainAnchor: { ...reverified.chainAnchor, manifestHash }
    } as PublicLedgerBundle;

    const score = scoreBundle(anchored);
    expect(score.integrity.seal).toBe("anchored");

    const verification = verifyBundleHash(anchored);
    expect(verification.valid).toBe(true);
    expect(verification.chainAnchorValid).toBe(true);

    const html = renderBundle(anchored, score);
    expect(html).not.toContain("AUTHEN-");
    expect(html).toContain("ANCHORED ON 0G");
    expect(html).toContain("matches on-chain anchor");
    expect(html).not.toContain("DEV ANCHOR (0g-dev)");
    expect(html).not.toContain("fingerprint mismatch");
  });

  it("uses scoreBundle on a real pipeline bundle and reaches A/S tier", () => {
    // Reaching A/S requires the independence multiplier, which now demands a real recovering
    // 0g-compute attestation AND the live on-chain signer leg (withSignerLeg).
    const bundle = withSignerLeg(attestedBundle());
    const score = scoreBundle(bundle);
    expect(["S", "A"]).toContain(score.tier);
  });
});

describe("local verifier wiring (smoke)", () => {
  it("runLocalVerifier yields an independent verifier and verified badges", async () => {
    const graph = buildArtifactGraph({
      traces: [
        {
          spanId: "s1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T09:50:00.000Z",
          endedAt: "2026-06-17T09:58:00.000Z",
          promptHash: hx("c"),
          responseHash: hx("d"),
          filesMentioned: [],
          artifactsProduced: ["src/index.ts"],
          metadata: {}
        }
      ],
      snapshots: [
        {
          snapshotId: "snapshot:abc123",
          commit: "abc123",
          branch: "no-git",
          createdAt: "2026-06-17T10:00:00.000Z",
          files: [{ path: "src/index.ts", size: 284, hash: hx("a") }],
          packageMetadata: {}
        }
      ],
      claims: [{ claimId: "ai-build", text: "AI build", selectors: ["src/index.ts"] }]
    });
    const verifier = await runLocalVerifier({ graph, now: () => "2026-06-17T10:01:00.000Z" });
    expect(verifier.verifierRun.model).toBe("deterministic-lineage-verifier");
    expect(verifier.evidenceBadges.some((b) => b.status === "verified")).toBe(true);
  });
});

describe("real seed bundle → RegistrySummary (no fabricated data)", () => {
  const bundles = loadSeedBundles();

  it("has at least the dogfooded VibeTrace bundle published", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(1);
  });

  it("derives a summary whose fields come straight from the real bundle", () => {
    const bundle = bundles[0];
    const summary = summarize(bundle, "2026-06-17T16:08:00.000Z");
    const score = scoreBundle(bundle);

    expect(summary.project).toBe(bundle.manifest.project.name);
    expect(summary.vibeScore).toBe(score.vibeScore);
    expect(summary.tier).toBe(score.tier);
    expect(summary.seal).toBe(score.integrity.seal);
    expect(summary.anchored).toBe(score.integrity.anchored);
    expect(summary.bundleHash).toBe(hashPublicLedgerBundle(bundle));
    // fileCount / verifiedClaims derived from real nodes + badges.
    expect(summary.fileCount).toBe(
      bundle.publicGraph.nodes.filter((n) => n.type === "FileVersion").length
    );
    expect(summary.verifiedClaims).toBe(
      bundle.evidenceBadges.filter((b) => b.status === "verified").length
    );
    // tools are distinct tool·model pairs taken from TraceSpan nodes.
    expect(summary.tools.length).toBeGreaterThanOrEqual(1);
    for (const t of summary.tools) {
      expect(t.tool).toBeTruthy();
      expect(t.model).toBeTruthy();
    }
  });
});

describe("renderLeaderboard (RegistrySummary[])", () => {
  it("sorts entries desc by vibeScore and renders tier + repo + #/p/ link for each", () => {
    // Build a small real-data set: the real seed plus two cloned variants with
    // forced scores so we can assert ordering without any fabricated bundles.
    const base = summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z");
    const entries: RegistrySummary[] = [
      { ...base, id: "low", repo: "repo/low", buildScore: 10, buildTier: "D", vibeScore: 10, tier: "D" },
      { ...base, id: "high", repo: "repo/high", buildScore: 90, buildTier: "S", vibeScore: 90, tier: "S" },
      { ...base, id: "mid", repo: "repo/mid", buildScore: 50, buildTier: "B", vibeScore: 50, tier: "B" }
    ];

    const html = renderLeaderboard(entries);
    expect(html).toContain("Leaderboard");

    const ranked = [...entries].sort((a, b) => b.buildScore - a.buildScore);
    const linkOrder = ranked.map((e) => html.indexOf(`#/p/${e.id}`));
    for (let i = 1; i < linkOrder.length; i++) {
      expect(linkOrder[i]).toBeGreaterThan(linkOrder[i - 1]);
    }
    for (const e of entries) {
      expect(html).toContain(`#/p/${e.id}`);
      expect(html).toContain(e.repo);
    }
    expect(html).toMatch(/>S</);
    expect(html).toMatch(/>D</);
  });

  it("does NOT render a manual URL submit form — builds come only from the CLI", () => {
    const base = summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z");
    const html = renderLeaderboard([base]);
    // The old manual-submit form hooks must be entirely gone.
    expect(html).not.toContain("data-submit-form");
    expect(html).not.toContain("data-submit-input");
    expect(html).not.toContain("data-submit-btn");
    expect(html).not.toContain("data-submit-msg");
    expect(html).not.toContain('type="url"');
  });

  it("renders the 'Get on the board' npx vibetrace callout with a copy button", () => {
    const base = summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z");
    const html = renderLeaderboard([base]);
    expect(html).toContain("Get on the board");
    expect(html).toContain("npx vibetrace");
    // honest one-liner: no forms.
    expect(html).toMatch(/no forms/i);
    // reuses the [data-copy-badge] copy-button pattern, carrying the command.
    expect(html).toContain("data-copy-badge");
    expect(html).toContain('data-copy-text="npx vibetrace"');
    expect(html).toContain("data-copy-label");
  });

  it("handles the sparse/empty board invitingly (no broken-looking empty state)", () => {
    const empty = renderLeaderboard([]);
    // The CLI callout is always available; the board invites the first build.
    expect(empty).toContain("Get on the board");
    expect(empty).toContain("npx vibetrace");
    expect(empty).toContain("be the first");
    expect(empty).not.toContain("data-submit-form");
    expect(empty).not.toMatch(/undefined|NaN/);

    const single = renderLeaderboard([summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z")]);
    expect(single).toContain("1 project so far");
  });

  it("keeps the live marquee and a consistent top nav on the leaderboard", () => {
    const html = renderLeaderboard([summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z")]);
    expect(html).toContain("LIVE");
    expect(html).toContain('href="#/leaderboard"');
    expect(html).toContain('href="#/"');
  });
});

describe("renderLanding — the product landing (narrative, distinct page)", () => {
  const entries: RegistrySummary[] = [
    { ...summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z"), id: "top", repo: "repo/top", vibeScore: 88, tier: "A" },
    { ...summarize(loadSeedBundles()[0], "2026-06-17T15:00:00.000Z"), id: "mid", repo: "repo/mid", vibeScore: 60, tier: "B" },
    { ...summarize(loadSeedBundles()[0], "2026-06-17T14:00:00.000Z"), id: "low", repo: "repo/low", vibeScore: 30, tier: "C" }
  ];

  it("renders the hero hook headline and subhead with both CTAs", () => {
    const html = renderLanding(entries);
    expect(html).toContain("Prove your software");
    expect(html).toContain("built with AI.");
    // The hero now leads with the new two-signals (Build + Proof) story.
    expect(html).toContain("two honest signals");
    expect(html).toContain("0G");
    // CTA: see the leaderboard → #/leaderboard ; add to project → #integrate
    expect(html).toContain('href="#/leaderboard"');
    expect(html).toContain('href="#integrate"');
  });

  it("renders the how-it-works beats (capture, link, verify, anchor, score & publish)", () => {
    const html = renderLanding(entries);
    expect(html).toContain("How it works");
    expect(html).toContain("Capture");
    expect(html).toContain("Link");
    expect(html).toContain("Verify");
    expect(html).toContain("Anchor");
    expect(html).toContain("Score & publish");
  });

  it("explains the VibeScore as Build vs Proof and renders the full S→D build-tier ladder", () => {
    const html = renderLanding(entries);
    expect(html).toContain("VibeScore");
    expect(html).toContain("Build Score");
    expect(html).toContain("Proof");
    for (const tier of ["S", "A", "B", "C", "D"]) {
      expect(html).toMatch(new RegExp(`>${tier}<`));
    }
    expect(html).toContain("Fully AI-Traced");
    expect(html).toContain("Heavily AI-Built");
    expect(html).toContain("Substantially AI-Built");
    expect(html).toContain("Partially AI-Built");
    expect(html).toContain("Lightly AI-Touched");
  });

  it("peeks the top-3 of the real leaderboard, sorted desc, with #/p/ links", () => {
    const html = renderLanding(entries);
    const ranked = [...entries].sort((a, b) => b.vibeScore - a.vibeScore);
    const order = ranked.map((e) => html.indexOf(`#/p/${e.id}`));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
    expect(html).toContain("See full leaderboard");
  });

  it("handles the sparse / just-VibeTrace case gracefully (never looks broken/empty)", () => {
    const one = renderLanding([entries[0]]);
    expect(one).toContain(`#/p/${entries[0].id}`);
    expect(one).toContain("Be the next");
    expect(one).not.toMatch(/undefined|NaN/);

    const none = renderLanding([]);
    expect(none).toContain("Prove your software");
    expect(none).toContain("Be the next");
    expect(none).not.toMatch(/undefined|NaN/);
  });

  it("leads the integrate CTA with the single npx vibetrace command", () => {
    const html = renderLanding(entries);
    expect(html).toContain('id="integrate"');
    // The hero command is `npx vibetrace`.
    expect(html).toContain("npx vibetrace");
    // The multi-step CLI is still mentioned, but de-emphasized (footnote).
    expect(html).toContain("pnpm add -D @vibetrace/cli");
    expect(html).toContain("vibetrace init");
    expect(html).toContain("vibetrace publish");
    // No manual "submit a URL" path remains on the landing.
    expect(html).not.toMatch(/Submit your build/i);
  });

  it("includes the shared top nav (wordmark home + leaderboard link)", () => {
    const nav = renderNav("landing");
    expect(nav).toContain("VibeTrace");
    expect(nav).toContain('href="#/"');
    expect(nav).toContain('href="#/leaderboard"');
  });
});

describe("shared site footer (present on every route)", () => {
  const landingEntries: RegistrySummary[] = [
    summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z")
  ];

  function expectFooter(html: string): void {
    // Single-line footer: brand + compact honest disclaimer + links + copyright.
    expect(html).toContain('aria-label="Site footer"');
    expect(html).toContain("Hash evidence, not a quality guarantee.");
    expect(html).toContain("© 2026 VibeTrace");
    // Footer nav + contact links.
    expect(html).toContain('href="#/leaderboard"');
    expect(html).toContain('href="https://github.com/"');
    expect(html).toContain('href="mailto:hello@vibetrace.dev"');
    // Powered by 0G — the official glitch wordmark, linked to 0g.ai.
    expect(html).toContain("Powered by");
    expect(html).toContain('href="https://0g.ai"');
    expect(html).toContain('class="og0g"');
  }

  it("renders the footer on the landing page", () => {
    expectFooter(renderLanding(landingEntries));
  });

  it("renders the footer on the leaderboard page", () => {
    expectFooter(renderLeaderboard(landingEntries));
  });

  it("renders the footer on the build-story page", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    expectFooter(renderBundle(bundle, score));
  });
});

describe("no pulsing-dot animations on status badges", () => {
  const entries: RegistrySummary[] = [
    summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z")
  ];

  it("the live marquee LIVE badge has a static dot (no blink class)", () => {
    const html = renderLiveMarquee(entries);
    expect(html).toContain("LIVE");
    expect(html).not.toContain("blink");
  });

  it("the landing 'local-first' badge has no pulsing dot", () => {
    const html = renderLanding(entries);
    expect(html).toContain("Local-first proof-of-build ledger");
    expect(html).not.toContain("blink");
  });

  it("the build-story 'verify it yourself' badge has no pulse ring", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("Verify it yourself");
    // No pulsing keyframe classes on any dot.
    expect(html).not.toMatch(/\bring\b/);
    expect(html).not.toContain("blink");
  });
});

describe("live submissions marquee (RegistrySummary[])", () => {
  const entries: RegistrySummary[] = [
    summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z"),
    { ...summarize(loadSeedBundles()[0], "2026-06-17T15:00:00.000Z"), id: "alt", repo: "repo/alt" }
  ];

  it("renders submission feed items (repo + tier + score), not the old static taglines", () => {
    const html = renderLiveMarquee(entries);
    expect(html).toContain("LIVE");
    expect(html).not.toContain("PROOF-OF-BUILD LEDGER");
    expect(html).not.toContain("LOCAL-FIRST <span");

    const top = [...entries].sort((a, b) => (b.buildScore ?? b.vibeScore) - (a.buildScore ?? a.vibeScore))[0];
    expect(html).toContain(top.repo);
    expect(html).toContain(String(top.buildScore ?? top.vibeScore));
    expect(html).toMatch(/●/);
  });

  it("rotating the lead index reorders the feed (visibly updates)", () => {
    const a = renderMarqueeBar(entries, 0);
    const b = renderMarqueeBar(entries, 1);
    expect(a).not.toBe(b);
  });

  it("each timestamp span carries a data-ts attribute for in-place ticking (no track replacement)", () => {
    const html = renderLiveMarquee(entries);
    const matches = html.match(/data-ts="\d+"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(entries.length * 2);
    const tsValues = matches.map((m) => Number(m.replace(/[^0-9]/g, "")));
    for (const ts of tsValues) {
      expect(ts).toBeGreaterThan(0);
    }
  });

  it("relativeTime formats the minutes-ago seed (just now → Xm → Xh)", () => {
    expect(relativeTime(0)).toBe("just now");
    expect(relativeTime(3)).toBe("3m ago");
    expect(relativeTime(90)).toBe("1h ago");
  });

  it("relativeTimeFromIso formats an ISO submission timestamp and falls back gracefully", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTimeFromIso(fiveMinAgo)).toMatch(/m ago$/);
    expect(relativeTimeFromIso("not-a-date")).toBe("—");
  });

  it("renders a real submission item from a single-entry registry (graceful, not empty)", () => {
    const single = [summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z")];
    const html = renderLiveMarquee(single);
    expect(html).toContain("LIVE");
    expect(html).toContain(single[0].repo);
    expect(html).toMatch(/●/);
  });

  it("fails closed: a teeVerified entry with a BROKEN seal shows NO TEE marquee mark (parity with the leaderboard pill)", () => {
    const base = summarize(loadSeedBundles()[0], "2026-06-17T16:08:00.000Z");
    const brokenTee = { ...base, id: "brk", repo: "repo/broken", teeVerified: true, seal: "broken" as RegistrySummary["seal"] };
    const okTee = { ...base, id: "ok", repo: "repo/ok", teeVerified: true, seal: "self-published" as RegistrySummary["seal"] };
    expect(renderLiveMarquee([brokenTee])).not.toContain('data-tee="1"');
    expect(renderLiveMarquee([okTee])).toContain('data-tee="1"');
  });

  it("renders gracefully for an empty registry (no crash, marquee host present)", () => {
    const html = renderLiveMarquee([]);
    // Empty bar still renders a host wrapper; nothing undefined/NaN leaks out.
    expect(html).toContain("data-marquee-host");
    expect(html).not.toMatch(/undefined|NaN/);
  });
});

describe("renderBundle navigation affordance", () => {
  it("renders a back-to-leaderboard link and the live marquee on the story page", () => {
    const bundle = loadSeedBundles()[0];
    const score = scoreBundle(bundle);
    const entries = [summarize(bundle, "2026-06-17T16:08:00.000Z")];
    const html = renderBundle(bundle, score, entries);
    expect(html).toContain('href="#/"');
    expect(html).toContain("Leaderboard");
    expect(html).toContain("LIVE");
  });
});

import {
  worstVerdict,
  verdictWordAndClass,
  substantiatedFlaggedCounts,
  sealState,
  type SealState
} from "./viewer";

/** Clone anchoredBundle() and graft a TeeAttestation + verdicts onto verifierSummary.
 *  Re-hashes the bundle so verification.valid === true (attestation is part of the hash payload). */
function attestedBundle(opts?: {
  processResponseValid?: boolean;
  provider?: string;
  verdicts?: { claimId: string; verdict: "substantiated" | "inflated" | "unsupported" }[];
  evidenceTier?: "private" | "public-only";
  /** Extra/override attestation fields (e.g. attestationQuoteUri, raDownloadLink)
   *  merged in before re-hashing — lets a test exercise the RA-link rendering. */
  attestation?: Record<string, unknown>;
}): PublicLedgerBundle {
  const base = anchoredBundle();
  // REAL recovering attestation: signature recovers to signingAddress (the display
  // gate isDisplayEligibleAttestation now requires this, not just shape).
  const attestation = {
    scheme: "0g-teeml" as const,
    attests: "tee-execution" as const,
    providerAddress: "0xprovider000000000000000000000000000000aa",
    signingAddress: TEST_SIGNING_ADDRESS,
    signature: TEST_SIGNATURE,
    signedDigest: TEST_SIGNED_DIGEST,
    responseTextHash: "0xbeef",
    processResponseValid: opts?.processResponseValid ?? true,
    teeType: "TDX",
    composeVerificationPassed: true,
    signerAllMatch: true,
    verifiedAt: "2026-06-17T10:02:00.000Z",
    verifiedBy: "vibetrace-relayer",
    ...(opts?.attestation ?? {})
  };
  // Build the modified bundle (with attestation in verifierSummary, which IS under the hash).
  const withAttestation = {
    ...base,
    verifierSummary: {
      ...base.verifierSummary,
      provider: opts?.provider ?? "0g-compute",
      model: "gpt-5-tee",
      evidenceTier: opts?.evidenceTier ?? "public-only",
      attestation,
      verdicts: opts?.verdicts ?? [{ claimId: "claim:ai-build", verdict: "substantiated" }]
    }
  } as unknown as PublicLedgerBundle;
  // Re-hash so manifest.publicBundleHash reflects the updated verifierSummary.
  // verifyBundleHash() will then return valid===true, and sealState won't crack it.
  const newHash = hashPublicLedgerBundle(withAttestation);
  return {
    ...withAttestation,
    manifest: { ...withAttestation.manifest, publicBundleHash: newHash },
    chainAnchor: { ...withAttestation.chainAnchor, manifestHash: newHash }
  };
}

/** Attach a passing live on-chain signer leg so a bundle reads as genuinely INDEPENDENT —
 *  isIndependent now requires verifyAgainst0G.signer.matches === true beyond recovery
 *  (a recovering attestation alone is only execution-attested). Sidecar is excluded from the hash. */
function withSignerLeg(bundle: PublicLedgerBundle): PublicLedgerBundle {
  const signingAddress = String(
    (bundle.verifierSummary as { attestation?: { signingAddress?: string } }).attestation?.signingAddress ?? ""
  );
  const manifestHash = String(bundle.manifest.publicBundleHash ?? "");
  return {
    ...bundle,
    verifyAgainst0G: {
      storage: { rootHash: String(bundle.storageAnchor.rootHash ?? ""), recomputedHash: manifestHash, matches: true },
      chain: {
        txHash: String(bundle.chainAnchor.txHash ?? ""),
        calldataManifestHash: manifestHash,
        expectedManifestHash: manifestHash,
        matches: true,
        readAt: "2026-06-17T10:05:00.000Z"
      },
      signer: {
        providerAddress: "0xprovider000000000000000000000000000000aa",
        expectedSigner: signingAddress,
        onChainSigner: signingAddress,
        acknowledgedOnChain: true,
        quoteVerified: false,
        matches: true
      }
    }
  } as unknown as PublicLedgerBundle;
}

describe("receipts card — sealState (honest fail states)", () => {
  it("attested: real 0g-compute provider + passing processResponse → attested seal carrying the real signature", () => {
    const bundle = attestedBundle();
    const state: SealState = sealState(bundle, verifyBundleHash(bundle));
    expect(state.kind).toBe("attested");
    // the seal HEADLINES the attestation state, not the per-claim verdict
    expect(state.verdictWord).toBe("0G TEE EXAMINED");
    // rim ornament IS the real enclave signature (shortened) + signing address
    expect(state.sigShort).toContain(TEST_SIGNATURE.slice(0, 6));
    expect(state.signingAddress).toBe(TEST_SIGNING_ADDRESS);
    expect(state.modelId).toBe("gpt-5-tee");
  });

  it("LEGACY: a bundle MISSING attestation.attests is NOT shown as attested (degrades to structural, never throws)", () => {
    const bundle = attestedBundle();
    // Strip the field to mimic a bundle written before `attests` existed, then re-hash so the
    // tamper gate stays valid (we are testing the attests gate, not a hash mismatch).
    delete (bundle.verifierSummary as { attestation?: { attests?: unknown } }).attestation!.attests;
    const reHashed = (() => {
      const h = hashPublicLedgerBundle(bundle);
      return {
        ...bundle,
        manifest: { ...bundle.manifest, publicBundleHash: h },
        chainAnchor: { ...bundle.chainAnchor, manifestHash: h }
      } as PublicLedgerBundle;
    })();
    const state = sealState(reHashed, verifyBundleHash(reHashed));
    // processResponseValid is true, so it is not "cracked"; but with no `attests` it is NOT "attested".
    expect(state.kind).not.toBe("attested");
  });

  // sealState uses the SAME strict shape gate as the leaderboard (isDisplayEligibleAttestation):
  // scheme==="0g-teeml" AND non-empty signingAddress/signature/signedDigest are all required.
  it.each([
    ["scheme", { scheme: "wrong-scheme" }],
    ["signature", { signature: "" }],
    ["signedDigest", { signedDigest: "" }],
    ["signingAddress", { signingAddress: "" }]
  ] as const)("SHAPE GATE: a bundle with a bad/empty %s is NOT shown as attested", (_field, patch) => {
    const bundle = attestedBundle();
    Object.assign(
      (bundle.verifierSummary as unknown as { attestation: Record<string, unknown> }).attestation,
      patch
    );
    const reHashed = (() => {
      const h = hashPublicLedgerBundle(bundle);
      return {
        ...bundle,
        manifest: { ...bundle.manifest, publicBundleHash: h },
        chainAnchor: { ...bundle.chainAnchor, manifestHash: h }
      } as PublicLedgerBundle;
    })();
    const state = sealState(reHashed, verifyBundleHash(reHashed));
    expect(state.kind).not.toBe("attested");
  });

  // RECOVERY GATE: a fully shape-valid attestation whose signature does NOT recover to
  // signingAddress (a forger substituted the signer) is NOT shown as attested. This is
  // the forgeable case the shape-only gate let through.
  it("RECOVERY GATE: a shape-valid but NON-RECOVERING attestation is NOT shown as attested (no seal forgery)", () => {
    const bundle = attestedBundle();
    // Substitute the signer so recoverAddress(signedDigest, signature) !== signingAddress.
    (bundle.verifierSummary as unknown as { attestation: Record<string, unknown> }).attestation.signingAddress =
      "0x" + "0".repeat(40);
    const reHashed = (() => {
      const h = hashPublicLedgerBundle(bundle);
      return {
        ...bundle,
        manifest: { ...bundle.manifest, publicBundleHash: h },
        chainAnchor: { ...bundle.chainAnchor, manifestHash: h }
      } as PublicLedgerBundle;
    })();
    const state = sealState(reHashed, verifyBundleHash(reHashed));
    expect(state.kind).not.toBe("attested");
    // And the full story page renders NONE of the TEE treatment for the forged attestation.
    const html = renderBundle(reHashed, scoreBundle(reHashed));
    expect(html).not.toContain("tee-band");
    expect(html).not.toContain("0G TEE EXAMINED");
  });

  it("attested seal headlines the examination state, NEVER the worst per-claim verdict", () => {
    const bundle = attestedBundle({
      verdicts: [
        { claimId: "a", verdict: "substantiated" },
        { claimId: "b", verdict: "inflated" }
      ]
    });
    const state = sealState(bundle, verifyBundleHash(bundle));
    expect(state.kind).toBe("attested");
    // NOT "INFLATED" — the seal is the attestation state; the per-claim verdicts live in the
    // stat-row breakdown + the examiner claim cards, so a mixed result never reads as a fail.
    expect(state.verdictWord).toBe("0G TEE EXAMINED");
    expect(state.verdictClass).toContain("bg-wax");
  });

  it("cracked: attestation present but processResponse failed → SEAL UNVERIFIED, never green", () => {
    const bundle = attestedBundle({ processResponseValid: false });
    const state = sealState(bundle, verifyBundleHash(bundle));
    expect(state.kind).toBe("cracked");
    expect(state.verdictWord).toBe("SEAL UNVERIFIED");
  });

  it("structural-only: no attestation / non-0g-compute provider → LOCAL CHECK ONLY, no wax seal", () => {
    const bundle = anchoredBundle(); // provider 0g-router, no attestation
    const state = sealState(bundle, verifyBundleHash(bundle));
    expect(state.kind).toBe("structural-only");
    expect(state.verdictWord).toBe("LOCAL CHECK ONLY");
  });

  it("tampered-but-attested: attestation passes but bundle hash is wrong → cracked, never attested", () => {
    // Take an attested bundle and corrupt its manifest hash so verification.valid === false.
    const base = attestedBundle();
    const tampered: PublicLedgerBundle = {
      ...base,
      manifest: { ...base.manifest, publicBundleHash: "0x" + "dead".repeat(16) }
    };
    const verification = verifyBundleHash(tampered);
    expect(verification.valid).toBe(false); // guard: the tamper must actually fail
    const state = sealState(tampered, verification);
    expect(state.kind).toBe("cracked");
    expect(state.verdictWord).toBe("SEAL UNVERIFIED");
  });

  it("attested + verifyAgainst0G storage mismatch → cracked, never attested", () => {
    const base = attestedBundle();
    const withBadSidecar: PublicLedgerBundle = {
      ...base,
      verifyAgainst0G: {
        storage: { rootHash: "0x" + "8".repeat(64), recomputedHash: "0x" + "0".repeat(64), matches: false },
        chain: { txHash: "0x" + "9".repeat(64), calldataManifestHash: "0x" + "a".repeat(64), expectedManifestHash: "0x" + "a".repeat(64), matches: true, readAt: "2026-06-17T10:00:00.000Z" }
      }
    } as PublicLedgerBundle;
    const verification = verifyBundleHash(withBadSidecar);
    const state = sealState(withBadSidecar, verification);
    expect(state.kind).toBe("cracked");
    expect(state.verdictWord).toBe("SEAL UNVERIFIED");
  });

  it("attested + verifyAgainst0G chain mismatch → cracked, never attested", () => {
    const base = attestedBundle();
    const withBadSidecar: PublicLedgerBundle = {
      ...base,
      verifyAgainst0G: {
        storage: { rootHash: "0x" + "8".repeat(64), recomputedHash: "0x" + "8".repeat(64), matches: true },
        chain: { txHash: "0x" + "9".repeat(64), calldataManifestHash: "0x" + "0".repeat(64), expectedManifestHash: "0x" + "a".repeat(64), matches: false, readAt: "2026-06-17T10:00:00.000Z" }
      }
    } as PublicLedgerBundle;
    const verification = verifyBundleHash(withBadSidecar);
    const state = sealState(withBadSidecar, verification);
    expect(state.kind).toBe("cracked");
    expect(state.verdictWord).toBe("SEAL UNVERIFIED");
  });

  it("attested + verifyAgainst0G signer mismatch → cracked, never attested", () => {
    const base = attestedBundle();
    const withBadSigner: PublicLedgerBundle = {
      ...base,
      verifyAgainst0G: {
        storage: { rootHash: "0x" + "8".repeat(64), recomputedHash: "0x" + "8".repeat(64), matches: true },
        chain: { txHash: "0x" + "9".repeat(64), calldataManifestHash: "0x" + "a".repeat(64), expectedManifestHash: "0x" + "a".repeat(64), matches: true, readAt: "2026-06-17T10:00:00.000Z" },
        // The signer re-verification against live 0G failed (e.g. a self-minted keypair, not the
        // provider's on-chain-acknowledged + quote-verified signer) → the seal MUST crack.
        signer: { providerAddress: "0xa48f", expectedSigner: "0x" + "9".repeat(40), onChainSigner: "0x83df", acknowledgedOnChain: true, quoteVerified: true, matches: false }
      }
    } as PublicLedgerBundle;
    const verification = verifyBundleHash(withBadSigner);
    const state = sealState(withBadSigner, verification);
    expect(state.kind).toBe("cracked");
    expect(state.verdictWord).toBe("SEAL UNVERIFIED");
  });

  it("clean attested + both verifyAgainst0G matches true → attested (not cracked)", () => {
    const base = attestedBundle();
    const withGoodSidecar: PublicLedgerBundle = {
      ...base,
      verifyAgainst0G: {
        storage: { rootHash: "0x" + "8".repeat(64), recomputedHash: "0x" + "8".repeat(64), matches: true },
        chain: { txHash: "0x" + "9".repeat(64), calldataManifestHash: "0x" + "a".repeat(64), expectedManifestHash: "0x" + "a".repeat(64), matches: true, readAt: "2026-06-17T10:00:00.000Z" }
      }
    } as PublicLedgerBundle;
    const verification = verifyBundleHash(withGoodSidecar);
    const state = sealState(withGoodSidecar, verification);
    expect(state.kind).toBe("attested");
  });

  it("clean attested without any verifyAgainst0G sidecar → still attested (sidecar optional)", () => {
    // When the sidecar is absent, we don't downgrade — the sidecar is optional.
    const base = attestedBundle(); // no verifyAgainst0G on anchoredBundle()
    const verification = verifyBundleHash(base);
    expect(verification.valid).toBe(true);
    const state = sealState(base, verification);
    expect(state.kind).toBe("attested");
  });
});

describe("receipts card — verdict helpers", () => {
  it("worstVerdict returns the worst per-claim status (unsupported worst, substantiated best)", () => {
    expect(worstVerdict([{ verdict: "substantiated" }, { verdict: "inflated" }])).toBe("inflated");
    expect(worstVerdict([{ verdict: "substantiated" }, { verdict: "substantiated" }])).toBe("substantiated");
    expect(worstVerdict([{ verdict: "inflated" }, { verdict: "unsupported" }])).toBe("unsupported");
    expect(worstVerdict([])).toBeNull();
    expect(worstVerdict(undefined)).toBeNull();
  });

  it("verdictWordAndClass maps each verdict to its locked word + color class", () => {
    expect(verdictWordAndClass("substantiated")).toEqual({ word: "SUBSTANTIATED", cls: "bg-lime text-ink" });
    expect(verdictWordAndClass("inflated")).toEqual({ word: "INFLATED", cls: "bg-wax text-paperlight" });
    expect(verdictWordAndClass("unsupported")).toEqual({ word: "UNSUPPORTED", cls: "bg-sun text-ink" });
  });

  it("substantiatedFlaggedCounts splits substantiated vs everything-else (flagged)", () => {
    const counts = substantiatedFlaggedCounts([
      { verdict: "substantiated" },
      { verdict: "substantiated" },
      { verdict: "inflated" },
      { verdict: "unsupported" }
    ]);
    expect(counts).toEqual({ substantiated: 2, flagged: 2 });
    expect(substantiatedFlaggedCounts(undefined)).toEqual({ substantiated: 0, flagged: 0 });
  });
});

/* ── Badge endpoint output (GET /api/badge/:id.svg) ──
 *
 * These assert the exact SVG the registry middleware serves, via the shared
 * renderBadgeForId() the middleware itself calls. They cover the spec's badge
 * requirements: tier+score in the SVG, a well-formed SVG, and a muted
 * "unverified" badge for unknown ids — all reflecting the REAL stored summary,
 * never re-scored or hardcoded.
 */

/** A real StoredEntry from the dogfooded seed (the full bundle + its summary). */
function seedStoredEntry(): StoredEntry {
  const bundle = loadSeedBundles()[0];
  const summary = summarize(bundle, "2026-06-17T16:08:00.000Z");
  return { ...summary, bundle };
}

/** Minimal structural well-formedness check for an inline SVG string. */
function assertWellFormedSvg(svg: string): void {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toMatch(/width="\d+"/);
  expect(svg).toMatch(/height="\d+"/);
  expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
  expect(svg).toContain('role="img"');
  // Every opened tag is closed: balanced "<" and ">" (no truncation).
  expect((svg.match(/</g) ?? []).length).toBe((svg.match(/>/g) ?? []).length);
  expect(svg).not.toMatch(/undefined|NaN/);
}

describe("badge endpoint output (GET /api/badge/:id.svg)", () => {
  it("renders the REAL stored tier + score for a known id (flat), as a well-formed SVG", () => {
    const entry = seedStoredEntry();
    const svg = renderBadgeForId([entry], entry.id);

    assertWellFormedSvg(svg);
    // tier and score come straight off the stored summary (no re-scoring).
    expect(svg).toContain(entry.buildTier);
    expect(svg).toContain(String(entry.buildScore));
    // the flat badge always carries the "vibescore" label and the 0G suffix.
    expect(svg).toContain("vibescore");
    expect(svg).toContain("0G");
    // sanity: this is NOT the muted/unverified badge.
    expect(svg).not.toContain("unverified");
  });

  it("matches a known id by full bundleHash as well as by short id", () => {
    const entry = seedStoredEntry();
    const byHash = renderBadgeForId([entry], entry.bundleHash);
    assertWellFormedSvg(byHash);
    expect(byHash).toContain(entry.buildTier);
    expect(byHash).toContain(String(entry.buildScore));
    expect(byHash).not.toContain("unverified");
  });

  it("renders the stamp variant with tier + score for ?style=stamp", () => {
    const entry = seedStoredEntry();
    const svg = renderBadgeForId([entry], entry.id, "stamp");
    assertWellFormedSvg(svg);
    expect(svg).toContain(entry.buildTier);
    expect(svg).toContain(String(entry.buildScore));
  });

  it("renders the MUTED 'unverified' badge for an unknown id (never a broken image)", () => {
    const entry = seedStoredEntry();
    const svg = renderBadgeForId([entry], "does-not-exist");

    assertWellFormedSvg(svg);
    expect(svg).toContain("unverified");
    expect(svg).toBe(mutedBadgeSvg());
    // a muted badge must NOT leak the real tier/score of any stored entry.
    expect(svg).not.toContain(String(entry.buildScore));
    // it uses the muted grey/ink palette, not a tier colour.
    expect(svg).toContain("#e6e2d6");
  });

  it("renders the MUTED 'unverified' badge for an empty id (e.g. /api/badge/.svg)", () => {
    const svg = renderBadgeForId([seedStoredEntry()], "");
    assertWellFormedSvg(svg);
    expect(svg).toContain("unverified");
    expect(svg).toBe(mutedBadgeSvg());
  });

  it("renders the MUTED 'unverified' badge against an empty store", () => {
    const svg = renderBadgeForId([], "anything");
    assertWellFormedSvg(svg);
    expect(svg).toContain("unverified");
  });

  it("colours the badge value segment by tier (Neo-Brutal tier palette)", () => {
    // tierBadgeColors is the single source of truth for badge fills; the flat
    // badge must paint its value segment with that tier colour.
    expect(tierBadgeColors("S")).toEqual({ bg: "#c6f135", fg: "#0b0b0f" });
    expect(tierBadgeColors("A")).toEqual({ bg: "#c6f135", fg: "#0b0b0f" });
    expect(tierBadgeColors("B")).toEqual({ bg: "#1d4ed8", fg: "#ffffff" });
    expect(tierBadgeColors("C")).toEqual({ bg: "#ffc400", fg: "#0b0b0f" });
    // Tier D is INK on coral, NOT white-on-coral: white-on-coral (~3.39:1)
    // fails WCAG AA, ink-on-coral (~6:1) is legible. Aligned with the app's
    // D-tier stamps (leaderboard pill, landing ladder, viewer TIER_BG).
    expect(tierBadgeColors("D")).toEqual({ bg: "#fb4d26", fg: "#0b0b0f" });
    // unknown tier → muted grey, never a crash.
    expect(tierBadgeColors("?")).toEqual({ bg: "#9aa0a6", fg: "#0b0b0f" });

    const sEntry: StoredEntry = { ...seedStoredEntry(), tier: "S", vibeScore: 91, buildTier: "S", buildScore: 91 };
    const svg = badgeForEntry(sEntry, "flat");
    expect(svg).toContain("#c6f135"); // S/A tier lime fill in the SVG
    expect(svg).toContain("S");
    expect(svg).toContain("91");
  });

  it("shows a ✓ check only for an anchored-verified seal", () => {
    const verified: StoredEntry = { ...seedStoredEntry(), seal: "anchored-verified", tier: "S", vibeScore: 91 };
    const unverified: StoredEntry = { ...verified, seal: "unanchored" };
    expect(badgeForEntry(verified, "flat")).toContain("✓");
    expect(badgeForEntry(unverified, "flat")).not.toContain("✓");
  });

  it("includes the ✓ in the STAMP variant for anchored-verified, omits it otherwise", () => {
    const verified: StoredEntry = { ...seedStoredEntry(), seal: "anchored-verified", tier: "S", vibeScore: 91, buildTier: "S", buildScore: 91 };
    const unverified: StoredEntry = { ...verified, seal: "unanchored" };
    const stampVerified = badgeForEntry(verified, "stamp");
    const stampUnverified = badgeForEntry(unverified, "stamp");
    assertWellFormedSvg(stampVerified);
    assertWellFormedSvg(stampUnverified);
    // The stamp now carries the same verification mark the flat badge shows.
    expect(stampVerified).toContain("✓");
    expect(stampUnverified).not.toContain("✓");
    // It still carries the tier + score.
    expect(stampVerified).toContain("S");
    expect(stampVerified).toContain("91");
  });

  it("D-tier badge uses ink-on-coral (legible), not white-on-coral", () => {
    const dEntry: StoredEntry = { ...seedStoredEntry(), tier: "D", vibeScore: 12, seal: "unanchored", buildTier: "D", buildScore: 12 };
    const svg = badgeForEntry(dEntry, "flat");
    assertWellFormedSvg(svg);
    expect(svg).toContain("#fb4d26"); // coral fill
    expect(svg).toContain('fill="#0b0b0f"'); // ink text on the value segment
    expect(svg).toContain("D");
    expect(svg).toContain("12");
  });

  it("stamp variant also paints the tier glyph in ink for D-tier", () => {
    const dStamp = stampBadgeSvg({ tier: "D", value: "12 · 0G", bg: "#fb4d26", fg: "#0b0b0f" });
    assertWellFormedSvg(dStamp);
    // The tier glyph text uses the ink fg, not white.
    expect(dStamp).toMatch(/fill="#0b0b0f">D</);
  });

  it("XML-escapes interpolated text so the SVG can't be broken by special chars", () => {
    expect(escapeXml(`<a> & "b" 'c'`)).toBe("&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;");
    const svg = flatBadgeSvg({ label: "vibescore", value: `A & <B>`, bg: "#c6f135", fg: "#0b0b0f" });
    assertWellFormedSvg(svg);
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;B&gt;");
    // the raw unescaped angle bracket must not appear inside the value text.
    expect(svg).not.toContain("<B>");
  });
});

/* ── Embed-your-badge section of renderBundle (id vs no-id branches) ── */

describe("renderEmbedBadge via renderBundle — registry-backed (has id)", () => {
  const id = "abc123def456";

  function storyHtml(): string {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    return renderBundle(bundle, score, [], id);
  }

  it("renders a LIVE <img> preview pointing at /api/badge/<id>.svg", () => {
    const html = storyHtml();
    expect(html).toContain(`src="/api/badge/${id}.svg"`);
    expect(html).toContain("<img");
    expect(html).toContain("Embed your badge");
    // the id-less fallback prompt must NOT appear when we have an id.
    expect(html).not.toContain("Submit your build to get a badge");
  });

  it("renders the EXACT copy-paste markdown snippet [![VibeScore <tier>](<badge>)](<story>)", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score, [], id);

    // In the node test env, currentOrigin() is "" (no `location`), so the
    // absolute URLs are origin-relative — assert that real rendered form.
    const expected = `[![VibeScore ${score.tier}](/api/badge/${id}.svg)](/#/p/${id})`;
    expect(html).toContain(expected);
  });

  it("renders the [data-copy-badge] button carrying the snippet as data-copy-text", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score, [], id);

    const snippet = `[![VibeScore ${score.tier}](/api/badge/${id}.svg)](/#/p/${id})`;
    expect(html).toContain("data-copy-badge");
    expect(html).toContain(`data-copy-text="${snippet}"`);
    // the snippet is also visible in a <code data-copy-badge-src> block.
    expect(html).toContain("data-copy-badge-src");
  });

  it("escapes the id used in the embed markup (no raw injection)", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score, [], 'evil"id<x>');
    // the id is HTML-escaped in the <img alt>/preview path and URL-encoded in URLs.
    expect(html).not.toContain('evil"id<x>');
  });
});

describe("renderEmbedBadge via renderBundle — external bundle (no id)", () => {
  it("renders the 'Submit your build to get a badge' fallback instead of a live badge", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score); // no id → external ?bundle= story

    expect(html).toContain("Want an embeddable badge?");
    expect(html).toContain("Submit your build to get a badge");
    // none of the registry-backed embed affordances should render.
    expect(html).not.toContain("/api/badge/");
    expect(html).not.toContain("data-copy-badge");
    expect(html).not.toContain("Copy the markdown");
  });
});

/* ── registry-core async handlers (shared by the Vite plugin + server.ts) ──
 *
 * These exercise the framework-agnostic core directly: createStore() seeds from
 * the committed test-fixtures bundle into a TEMP store file (never the dev
 * store), and each handler returns a { status, headers, body } result.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_SUBMIT_BODY_BYTES = 64 * 1024;
const TEST_BUNDLE_ARRAY_ITEMS = 20;

async function freshTempStore(limits?: Partial<RegistryLimits>): Promise<{ store: RegistryStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vibetrace-core-"));
  const store = await createStore({
    storePath: join(dir, "store.json"),
    seedDir: SEED_DIR,
    ...(limits ? { limits } : {})
  });
  return { store, dir };
}

function recomputeSubmittedHashes(bundle: PublicLedgerBundle): PublicLedgerBundle {
  const pending = {
    ...bundle,
    manifest: { ...bundle.manifest, publicBundleHash: "pending" },
    chainAnchor: { ...bundle.chainAnchor, manifestHash: "pending" }
  } as PublicLedgerBundle;
  const manifestHash = hashPublicLedgerBundle(pending);
  return {
    ...pending,
    manifest: { ...pending.manifest, publicBundleHash: manifestHash },
    chainAnchor: { ...pending.chainAnchor, manifestHash }
  };
}

describe("registry-core handlers", () => {
  it("createStore() seeds from the committed bundle fixture", async () => {
    const { store, dir } = await freshTempStore();
    try {
      expect(store.entries.length).toBeGreaterThan(0);
      // every seeded entry is a real scored bundle (has a tier + bundleHash).
      for (const e of store.entries) {
        expect(typeof e.tier).toBe("string");
        expect(e.bundleHash.startsWith("0x")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleRegistry returns sorted summaries as JSON (no bundles leaked)", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const res = await handleRegistry(store);
      expect(res.status).toBe(200);
      expect(res.headers["Content-Type"]).toContain("application/json");
      const rows = JSON.parse(res.body) as { vibeScore: number; bundle?: unknown }[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(store.entries.length);
      // summaries must NOT carry the full bundle.
      for (const r of rows) expect(r.bundle).toBeUndefined();
      // sorted desc by vibeScore.
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].vibeScore).toBeGreaterThanOrEqual(rows[i].vibeScore);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleBundle returns the full bundle for a known id, 404 otherwise", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const entry = store.entries[0];
      const ok = await handleBundle(store, entry.id);
      expect(ok.status).toBe(200);
      const bundle = JSON.parse(ok.body);
      expect(bundle.manifest).toBeDefined();
      expect(bundle.publicGraph).toBeDefined();

      // by full bundleHash too.
      const byHash = await handleBundle(store, entry.bundleHash);
      expect(byHash.status).toBe(200);

      const miss = await handleBundle(store, "does-not-exist");
      expect(miss.status).toBe(404);
      expect(JSON.parse(miss.body).error).toContain("does-not-exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleBadge returns image/svg+xml (200) and a muted badge for unknown ids", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const entry = store.entries[0];
      const known = await handleBadge(store, entry.id);
      expect(known.status).toBe(200);
      expect(known.headers["Content-Type"]).toContain("image/svg+xml");
      expect(known.body).toContain("<svg");
      expect(known.body).toContain(entry.buildTier);

      // ?style=stamp routes through the stamp variant.
      const stamp = await handleBadge(store, entry.id, "stamp");
      expect(stamp.status).toBe(200);
      expect(stamp.body).toContain("<svg");

      // unknown id → still 200, but the muted "unverified" badge.
      const unknown = await handleBadge(store, "nope");
      expect(unknown.status).toBe(200);
      expect(unknown.headers["Content-Type"]).toContain("image/svg+xml");
      expect(unknown.body).toContain("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects a missing bundle and invalid JSON without touching the store", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const missing = await handleSubmit(store, JSON.stringify({}));
      expect(missing.status).toBe(400);
      expect(JSON.parse(missing.body).error).toContain("Missing bundle");

      const badJson = await handleSubmit(store, "{not json");
      expect(badJson.status).toBe(400);
      expect(JSON.parse(badJson.body).error).toContain("Invalid JSON");

      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects bundleUrl without fetching because ingestion is CLI-only", async () => {
    const { store, dir } = await freshTempStore();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const before = store.entries.length;
      const res = await handleSubmit(store, JSON.stringify({ bundleUrl: "https://example.test/bundle.json" }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Missing bundle");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(store.entries.length).toBe(before);
    } finally {
      fetchSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects request bodies over the cap before parsing", async () => {
    const { store, dir } = await freshTempStore({ maxSubmitBytes: TEST_SUBMIT_BODY_BYTES });
    try {
      const before = store.entries.length;
      const tooLarge = JSON.stringify({ bundle: null, padding: "x".repeat(store.limits.maxSubmitBytes) });
      expect(Buffer.byteLength(tooLarge, "utf8")).toBeGreaterThan(store.limits.maxSubmitBytes);

      const res = await handleSubmit(store, tooLarge);
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).error).toMatch(/too large/i);
      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readLimitedRequestBody enforces its byte cap (an over-cap stream is rejected)", async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(64 * 1024);
      yield Buffer.from("x");
    }
    await expect(readLimitedRequestBody(chunks(), 64 * 1024)).rejects.toThrow(/too large/i);
  });

  it("handleSubmit accepts a directly POSTed { bundle } — scores, stores, and returns the entry (the npx vibetrace path)", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const bundle = anchoredBundle();
      const expectedHash = hashPublicLedgerBundle(bundle);
      const expectedScore = scoreBundle(bundle);

      const res = await handleSubmit(store, JSON.stringify({ bundle }));
      expect(res.status).toBe(200);
      const { entry } = JSON.parse(res.body) as { entry: RegistrySummary };

      // The returned summary reflects the real scored bundle (no fabrication).
      expect(entry.bundleHash).toBe(expectedHash);
      expect(entry.vibeScore).toBe(expectedScore.vibeScore);
      expect(entry.tier).toBe(expectedScore.tier);
      expect(entry.project).toBe(bundle.manifest.project?.name);
      // Summary must not leak the full bundle.
      expect((entry as unknown as { bundle?: unknown }).bundle).toBeUndefined();

      // It is now persisted and fetchable by id.
      expect(store.entries.length).toBe(before + 1);
      const stored = await handleBundle(store, entry.id);
      expect(stored.status).toBe(200);

      // Re-POSTing the same bundle dedupes by bundleHash (no duplicate row).
      const resAgain = await handleSubmit(store, JSON.stringify({ bundle }));
      expect(resAgain.status).toBe(200);
      expect(store.entries.length).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit dedupes by anchor identity plus FileVersion hash overlap, not only bundleHash", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const original = anchoredBundle();
      const originalRes = await handleSubmit(store, JSON.stringify({ bundle: original }));
      expect(originalRes.status).toBe(200);
      expect(store.entries.length).toBe(before + 1);

      const updated = recomputeSubmittedHashes({
        ...original,
        manifest: {
          ...original.manifest,
          project: { ...original.manifest.project, name: "Demo Reissued" }
        }
      } as PublicLedgerBundle);
      expect(hashPublicLedgerBundle(updated)).not.toBe(hashPublicLedgerBundle(original));

      const updatedRes = await handleSubmit(store, JSON.stringify({ bundle: updated }));
      expect(updatedRes.status).toBe(200);
      expect(store.entries.length).toBe(before + 1);

      const { entry } = JSON.parse(updatedRes.body) as { entry: RegistrySummary };
      expect(entry.project).toBe("Demo Reissued");
      expect(entry.bundleHash).toBe(hashPublicLedgerBundle(updated));
      expect(store.entries.find((e) => e.id === entry.id)?.bundle.manifest.project.name).toBe("Demo Reissued");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["nodes", (bundle: PublicLedgerBundle) => ({
      ...bundle,
      publicGraph: {
        ...bundle.publicGraph,
        nodes: Array.from({ length: TEST_BUNDLE_ARRAY_ITEMS + 1 }, (_, i) => ({
          id: `file:${i}`,
          type: "FileVersion" as const,
          label: `file-${i}.ts`,
          data: { path: `file-${i}.ts`, hash: hx("a"), size: 1, commit: "abc123" }
        }))
      }
    }) as PublicLedgerBundle],
    ["edges", (bundle: PublicLedgerBundle) => ({
      ...bundle,
      publicGraph: {
        ...bundle.publicGraph,
        edges: Array.from({ length: TEST_BUNDLE_ARRAY_ITEMS + 1 }, (_, i) => ({
          id: `edge:${i}`,
          from: "file:src/index.ts@abc123",
          to: "claim:ai-build",
          type: "supports" as const
        }))
      }
    }) as PublicLedgerBundle],
    ["evidenceBadges", (bundle: PublicLedgerBundle) => ({
      ...bundle,
      evidenceBadges: Array.from({ length: TEST_BUNDLE_ARRAY_ITEMS + 1 }, (_, i) => ({
        claimId: `claim:${i}`,
        status: "verified" as const,
        confidence: 0.9,
        supportingNodes: [],
        publicExplanation: "Artifact supports this claim."
      }))
    }) as PublicLedgerBundle]
  ])("handleSubmit rejects bundles with more than the configured %s cap", async (_name, mutate) => {
    const { store, dir } = await freshTempStore({ maxBundleArrayItems: TEST_BUNDLE_ARRAY_ITEMS });
    try {
      const before = store.entries.length;
      const res = await handleSubmit(store, JSON.stringify({ bundle: mutate(anchoredBundle()) }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/too many/i);
      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects posted bundles with malformed hash fields", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const badHash = {
        ...anchoredBundle(),
        verifierSummary: { ...anchoredBundle().verifierSummary, requestHash: "not-a-hex-hash" }
      } as PublicLedgerBundle;

      const res = await handleSubmit(store, JSON.stringify({ bundle: badHash }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/hash/i);
      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects a POSTed { bundle } that is not a valid PublicLedgerBundle", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const res = await handleSubmit(store, JSON.stringify({ bundle: { not: "a bundle" } }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("PublicLedgerBundle");
      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleSubmit rejects malformed publicGraph shapes instead of throwing", async () => {
    const { store, dir } = await freshTempStore();
    try {
      const before = store.entries.length;
      const malformed = {
        ...anchoredBundle(),
        publicGraph: { ...anchoredBundle().publicGraph, edges: undefined }
      };

      const res = await handleSubmit(store, JSON.stringify({ bundle: malformed }));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("PublicLedgerBundle");
      expect(store.entries.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeJsonFileAtomic writes valid JSON and leaves no temp file after replacement", async () => {
    const { dir } = await freshTempStore();
    try {
      const path = join(dir, "atomic.json");
      writeJsonFileAtomic(path, [{ before: true }]);
      writeJsonFileAtomic(path, [{ after: true }]);

      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ after: true }]);
      expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderReceiptsCard front (replaces the spinning stamp)", () => {
  it("leads with the flex line and the mono stat row, not the VibeScore", () => {
    const bundle = attestedBundle({
      verdicts: [
        { claimId: "a", verdict: "substantiated" },
        { claimId: "b", verdict: "substantiated" },
        { claimId: "c", verdict: "inflated" }
      ]
    });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("Yes, I vibe-coded this. Receipts attached.");
    // mono stat row: substantiated/flagged split (NOT "N verified")
    expect(html).toContain("2 SUBSTANTIATED");
    expect(html).toContain("1 FLAGGED");
    expect(html).toContain("files traced");
  });

  it("the spinning synthetic-text stamp is GONE (no spin-slow / textPath ring in the card)", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).not.toContain("spin-slow");
    expect(html).not.toContain("circlePath");
    expect(html).not.toContain("Certificate of Authenticity");
  });

  it("attested seal carries the REAL enclave signature on its rim + the attested chrome", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("SUBSTANTIATED");
    expect(html).toContain(`SIG ${TEST_SIGNATURE.slice(0, 6)}`);
    expect(html).toContain("0G TEE EXAMINED");
    // the seal element is the press target, tagged with its kind + verdict
    expect(html).toContain('data-seal-press');
    expect(html).toContain('data-seal-kind="attested"');
  });

  it("the attested seal FACE headlines '0G TEE EXAMINED', never a scary per-claim 'VERDICT: UNSUPPORTED'", () => {
    const bundle = attestedBundle({ verdicts: [{ claimId: "a", verdict: "unsupported" }] });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // the seal face is the attestation state — it does NOT headline the per-claim verdict
    expect(html).toContain("0G TEE EXAMINED");
    expect(html).not.toContain("VERDICT: UNSUPPORTED");
  });

  it("POLISH: the CRACKED face shows SEAL UNVERIFIED WITHOUT a 'VERDICT:' prefix (it's not a verdict)", () => {
    const bundle = attestedBundle({ processResponseValid: false });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("SEAL UNVERIFIED");
    expect(html).not.toContain("VERDICT: SEAL UNVERIFIED");
  });

  it("INFLATED build shows the word at full prominence with the wax color, zero shame", () => {
    const bundle = attestedBundle({
      verdicts: [{ claimId: "a", verdict: "inflated" }]
    });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("INFLATED");
    expect(html).toContain("bg-wax");
  });

  it("cracked attestation renders SEAL UNVERIFIED, never a green substantiated seal", () => {
    const bundle = attestedBundle({ processResponseValid: false });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("SEAL UNVERIFIED");
    expect(html).toContain('data-seal-kind="cracked"');
    expect(html).not.toContain(">SUBSTANTIATED<");
  });

  it("structural-only (no attestation) shows LOCAL CHECK ONLY and no fake wax seal", () => {
    const bundle = anchoredBundle(); // 0g-router, no attestation
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // Honest structural-only labelling: the verdict word "LOCAL CHECK ONLY" plus an
    // explicit "not independently examined" sub-label, and NO fake wax seal.
    expect(html).toContain("LOCAL CHECK ONLY");
    expect(html).toContain("Self-checked · not independently examined");
    expect(html).toContain('data-seal-kind="structural-only"');
    expect(html).not.toContain("0G TEE EXAMINED");
    expect(html).not.toContain("SIG 0x");
  });

  it("renders the honesty caption: attested ≠ correct (TEE EXECUTION, not a verdict-content signature)", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // Honest claim: execution attested by the acknowledged signer; verdict content relayed by the operator.
    expect(html).toContain("Examined by an inference running in an attested 0G TEE enclave");
    expect(html).toContain("Verdict content is relayed by the operator");
    // It must NOT assert the enclave put its signature over the verdict text.
    expect(html).not.toContain("signed its verdict");
  });
});

describe("VibeScore demoted below the fold", () => {
  it("renders the score quietly AFTER the story beats, below the receipts card", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    const cardIdx = html.indexOf("Yes, I vibe-coded this. Receipts attached.");
    const storyIdx = html.indexOf("How it was built");
    const scoreIdx = html.indexOf("Build Score");
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeGreaterThan(cardIdx);
    expect(scoreIdx).toBeGreaterThan(storyIdx); // below the fold, after the story
    expect(html).toContain(String(score.buildScore));
    expect(html).toContain(score.buildTierLabel);
  });
});

/** Graft a verifyAgainst0G sidecar onto a bundle for the read-back rows. */
function withReadBack(
  bundle: PublicLedgerBundle,
  opts?: { storageMatches?: boolean; chainMatches?: boolean }
): PublicLedgerBundle {
  return {
    ...bundle,
    verifyAgainst0G: {
      storage: {
        rootHash: bundle.storageAnchor.rootHash,
        recomputedHash: bundle.storageAnchor.rootHash,
        matches: opts?.storageMatches ?? true
      },
      chain: {
        txHash: bundle.chainAnchor.txHash,
        calldataManifestHash: hashPublicLedgerBundle(bundle),
        expectedManifestHash: hashPublicLedgerBundle(bundle),
        matches: opts?.chainMatches ?? true,
        readAt: "2026-06-17T10:03:00.000Z"
      }
    }
  } as unknown as PublicLedgerBundle;
}

describe("receipts drawer — verify it yourself", () => {
  it("renders the live client-side re-hash row carrying the expected bundle hash", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    const expected = hashPublicLedgerBundle(bundle);
    expect(html).toContain("BUNDLE");
    expect(html).toContain('data-live-rehash');
    expect(html).toContain(`data-expected-hash="${expected}"`);
  });

  it("renders the verifyAgainst0G sidecar as a MUTED publisher-reported claim, never trustless green", () => {
    const bundle = withReadBack(attestedBundle(), { storageMatches: true, chainMatches: true });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("0G STORAGE");
    expect(html).toContain("0G CHAIN");
    // Publisher-reported, NOT proof: muted "reported at publish", never a bold-green/trustless tick.
    // Both the storage and chain legs carry the same muted reported chip.
    expect(html).toContain("reported at publish: matched");
    expect(html).toContain("data-sidecar-reported");
    expect(html).not.toContain("re-hashed at publish: matches");
  });

  it("does NOT dangle a 'verify it yourself below' pointer when the live button is omitted (dev-local root)", () => {
    // attestedBundle() is a dev-local root (0g://local/…) → the live Fetch & re-hash button is
    // omitted. Even with a matched verifyAgainst0G sidecar attached, NEITHER the proof strip NOR
    // the drawer read-back copy may point "below" to a button that isn't there.
    const bundle = withReadBack(attestedBundle(), { storageMatches: true, chainMatches: true });
    expect(bundle.storageAnchor.uri.startsWith("0g://local/")).toBe(true);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).not.toContain("verify it yourself below");
    expect(html).not.toContain("data-fetch-rehash");
  });

  it("renders the sidecar MISMATCH honestly (never green) when the read-back failed", () => {
    const bundle = withReadBack(attestedBundle(), { storageMatches: false, chainMatches: true });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // The storage leg shows the mismatch in wax, not green.
    expect(html).toContain("✗ mismatch reported at publish");
    // The matching (chain) leg stays a muted reported-at-publish claim, never bold green.
    expect(html).toContain("reported at publish: matched");
  });

  it("the live Fetch & re-hash resolves a REAL upload to an HTTP 0G Storage gateway, NEVER 0g://", () => {
    // A real 0G Storage upload (provider 0g-storage, uri 0g://<root>) IS on the public
    // indexer, so it earns the live-fetch button resolved to an HTTP endpoint.
    const base = attestedBundle();
    const bundle = {
      ...base,
      storageAnchor: { ...base.storageAnchor, provider: "0g-storage", uri: `0g://${base.storageAnchor.rootHash}` }
    } as unknown as PublicLedgerBundle;
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("Fetch & re-hash");
    expect(html).toContain('data-fetch-rehash');
    // resolves rootHash to the HTTP indexer endpoint — the browser can fetch this.
    const expectedUrl = `https://indexer-storage-testnet-turbo.0g.ai/file?root=${bundle.storageAnchor.rootHash}`;
    expect(html).toContain(`data-bundle-url="${escapeHtml(expectedUrl)}"`);
    // HARD GUARD: the browser-facing fetch target must never be a 0g:// URL.
    expect(html).not.toContain('data-bundle-url="0g://');
    expect(html).not.toContain('fetch("0g://');
  });

  it("links the storage root to an INSPECT URL on 0G Storage for a REAL upload", () => {
    // A real upload's root should be openable: clicking it opens the stored object on
    // the 0G Storage indexer (the same HTTP host the Fetch & re-hash button targets).
    const base = attestedBundle();
    const bundle = {
      ...base,
      storageAnchor: { ...base.storageAnchor, provider: "0g-storage", uri: `0g://${base.storageAnchor.rootHash}` }
    } as unknown as PublicLedgerBundle;
    const html = renderBundle(bundle, scoreBundle(bundle));
    const inspectUrl = `https://indexer-storage-testnet-turbo.0g.ai/file?root=${bundle.storageAnchor.rootHash}`;
    expect(html).toContain(`href="${escapeHtml(inspectUrl)}"`);
  });

  it("does NOT link the storage root for a dev-local root (nothing public to inspect)", () => {
    // attestedBundle() is 0g://local/… — no public object, so the root stays plain text
    // with the honest note, never an inspect anchor.
    const bundle = attestedBundle();
    expect(bundle.storageAnchor.uri.startsWith("0g://local/")).toBe(true);
    const html = renderBundle(bundle, scoreBundle(bundle));
    expect(html).toContain("not on public 0G Storage");
    expect(html).not.toContain("indexer-storage-testnet-turbo.0g.ai/file");
  });

  it("OMITS the live Fetch & re-hash button for a dev-local root (never uploaded → would 404)", () => {
    // attestedBundle() uses provider 0g-dev + uri 0g://local/… — a LOCAL object the
    // public indexer never received. Linking a gateway URL would 404, so the button
    // must be omitted rather than expose a broken proof affordance.
    const bundle = attestedBundle();
    expect(bundle.storageAnchor.uri.startsWith("0g://local/")).toBe(true);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).not.toContain("Fetch & re-hash");
    expect(html).not.toContain("data-fetch-rehash");
    // And NEVER a raw 0g:// fetch target.
    expect(html).not.toContain('data-bundle-url="0g://');
  });

  it("links the 0G Chain tx to chainscan-galileo for a real on-chain anchor", () => {
    const bundle = bundleWithChainState("0g-chain", "match");
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("chainscan-galileo.0g.ai/tx/");
  });

  it("renders one examiner row per verdict with status word, support count, rationale", () => {
    // Build the attested bundle with all verdict fields included from the start so the
    // bundle hash is computed over the final verifierSummary (no post-hoc mutation).
    const bundle = attestedBundle({
      verdicts: [
        {
          claimId: "claim:oauth",
          verdict: "inflated",
          confidence: 0.4,
          supportingNodes: ["trace:abc", "file:auth/oauth.ts"],
          rationale: "linked to auth/oauth.ts but magnitude oversold",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "thin", contradiction: "none" }
        } as unknown as { claimId: string; verdict: "inflated" }
      ]
    });
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).toContain("EXAMINER");
    expect(html).toContain("INFLATED");
    expect(html).toContain("linked to auth/oauth.ts but magnitude oversold");
    expect(html).toContain("2 supporting nodes");
    // The signature explainer is now ONE shared footnote for an attested run
    // (not the old per-claim "verify execution signature" expander).
    expect(html).toContain("What the signature proves");
  });

  it("structural-only run shows no signature footnote (nothing was signed)", () => {
    const bundle = anchoredBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    expect(html).not.toContain("What the signature proves");
    expect(html).not.toContain("data-signature-note");
  });

  it("renders the signature explainer ONCE, not repeated per claim (no prose bloat)", () => {
    // Four claims would previously print the same ~60-word paragraph four times.
    // The explainer is now a single shared footnote at the foot of the section.
    const bundle = attestedBundle({
      verdicts: [
        { claimId: "claim:a", verdict: "unsupported" },
        { claimId: "claim:b", verdict: "unsupported" },
        { claimId: "claim:c", verdict: "substantiated" },
        { claimId: "claim:d", verdict: "unsupported" }
      ]
    });
    const html = renderBundle(bundle, scoreBundle(bundle));
    const noteCount = html.split("data-signature-note").length - 1;
    expect(noteCount).toBe(1);
    // The old per-claim paragraph must be gone entirely.
    expect(html).not.toContain("Recover the signer from");
  });
});

describe("receipts drawer — links are never dead (no non-http(s) anchors)", () => {
  it("renders a 0g:// RA quote as plain text, NEVER a clickable (dead) link", () => {
    // Browsers cannot open 0g:// — the previous code linked it raw, producing a
    // dead ↗. It must render as copyable text instead.
    const bundle = attestedBundle({
      attestation: { attestationQuoteUri: "0g://local/0x" + "7".repeat(64) }
    });
    const html = renderBundle(bundle, scoreBundle(bundle));
    expect(html).not.toContain('href="0g:');
    // …but the value is still shown (as text), not silently dropped.
    expect(html).toContain("0g://local");
  });

  it("links an http(s) RA report as a real anchor", () => {
    const bundle = attestedBundle({
      attestation: { raDownloadLink: "https://example.org/ra/report.json" }
    });
    const html = renderBundle(bundle, scoreBundle(bundle));
    expect(html).toContain('href="https://example.org/ra/report.json"');
  });

  it("renders an http(s) RA quote as a real anchor (links only what browsers can open)", () => {
    const bundle = attestedBundle({
      attestation: { attestationQuoteUri: "https://gateway.example/quote.json" }
    });
    const html = renderBundle(bundle, scoreBundle(bundle));
    expect(html).toContain('href="https://gateway.example/quote.json"');
  });
});

describe("seal press is a one-shot hook (animation fired by main.ts, not CSS loop)", () => {
  it("renders the seal as a press target without baking in an animation class", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // main.ts adds .seal-press once after render; markup must NOT pre-include it
    // (otherwise it would re-run on every re-render).
    expect(html).toContain("data-seal-press");
    expect(html).not.toContain("class=\"seal-press");
    expect(html).not.toContain("seal-press\"");
  });
});

describe("receipts card — deterministic front-card rows (honest state)", () => {
  function bundleWithSidecar(
    storageMatches: boolean | undefined,
    chainMatches: boolean | undefined
  ): PublicLedgerBundle {
    const base = anchoredBundle();
    if (storageMatches === undefined && chainMatches === undefined) {
      // No sidecar at all.
      return base;
    }
    return {
      ...base,
      verifyAgainst0G: {
        storage: {
          rootHash: "0x" + "8".repeat(64),
          recomputedHash: storageMatches ? "0x" + "8".repeat(64) : "0x" + "0".repeat(64),
          matches: storageMatches!
        },
        chain: {
          txHash: "0x" + "9".repeat(64),
          calldataManifestHash: chainMatches ? "0x" + "a".repeat(64) : "0x" + "0".repeat(64),
          expectedManifestHash: "0x" + "a".repeat(64),
          matches: chainMatches!,
          readAt: "2026-06-17T10:00:00.000Z"
        }
      }
    } as PublicLedgerBundle;
  }

  it("shows PUBLISHER-REPORTED 'reported at publish' framing (not trustless-green ✓) when sidecar matches===true", () => {
    // A sidecar matches===true is PUBLISHER-REPORTED and must NOT render as the
    // trustless-green ✓ reserved for live client-side verification. It must be
    // visually and textually distinct: muted/italic, carrying "reported at publish".
    const bundle = bundleWithSidecar(true, true);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // Both 0G rows show the "reported at publish" framing, not the trustless ✓.
    const storageIdx = html.indexOf("fetched from 0G Storage");
    const chainIdx = html.indexOf("0G Chain tx calldata");
    expect(storageIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(-1);
    // Reported framing is present on both rows.
    expect(html.slice(storageIdx, storageIdx + 300)).toContain("reported at publish");
    expect(html.slice(chainIdx, chainIdx + 300)).toContain("reported at publish");
    // Neither row has the trustless-green ✓ tick (that is reserved for live verification).
    expect(html.slice(storageIdx, storageIdx + 300)).not.toContain("✓");
    expect(html.slice(chainIdx, chainIdx + 300)).not.toContain("✓");
    // Neither row shows a mismatch cross.
    expect(html.slice(storageIdx, storageIdx + 300)).not.toContain("✗");
    expect(html.slice(chainIdx, chainIdx + 300)).not.toContain("✗");
    // Muted/italic style applied (not the ink/75 trustless style).
    expect(html.slice(storageIdx - 100, storageIdx + 300)).toContain("italic");
    // No "not recorded" either — the sidecar IS present.
    expect(html).not.toContain("not recorded at publish");
  });

  it("shows neutral 'not recorded' for both 0G rows when verifyAgainst0G is absent", () => {
    const bundle = bundleWithSidecar(undefined, undefined);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // Both rows have absent-state text; no ✓ tick on these rows.
    expect(html).toContain("not recorded");
    // There must be NO ✓ on the storage/chain rows (the hash row still has a tick).
    const storageIdx = html.indexOf("fetched from 0G Storage");
    const chainIdx = html.indexOf("0G Chain tx calldata");
    expect(storageIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(-1);
    expect(html.slice(storageIdx, storageIdx + 200)).not.toContain("✓");
    expect(html.slice(chainIdx, chainIdx + 200)).not.toContain("✓");
  });

  it("shows ✗ for both rows when storage.matches and chain.matches are false", () => {
    const bundle = bundleWithSidecar(false, false);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // Both rows show the mismatch indicator; no ✓ on these rows.
    const storageIdx = html.indexOf("fetched from 0G Storage");
    const chainIdx = html.indexOf("0G Chain tx calldata");
    expect(storageIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(-1);
    expect(html.slice(storageIdx, storageIdx + 200)).toContain("✗");
    expect(html.slice(chainIdx, chainIdx + 200)).toContain("✗");
    expect(html.slice(storageIdx, storageIdx + 200)).not.toContain("✓");
    expect(html.slice(chainIdx, chainIdx + 200)).not.toContain("✓");
    // Mismatch carries the "MISMATCH reported at publish" label (not just a bare cross).
    expect(html.slice(storageIdx, storageIdx + 300)).toContain("MISMATCH reported at publish");
    expect(html.slice(chainIdx, chainIdx + 300)).toContain("MISMATCH reported at publish");
  });

  it("sidecar matches===true does NOT render the same string as a live-verified pass (trusted/untrusted distinction)", () => {
    // This is the core honesty guard: the publisher-reported sidecar state and the
    // live-verified state must produce DIFFERENT HTML strings on the 0G rows so a
    // reader (or a future automated check) can distinguish them.
    const bundle = bundleWithSidecar(true, true);
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);

    // The 0G storage row must use the "reported at publish" framing, not any
    // trustless-proof language.
    const storageIdx = html.indexOf("fetched from 0G Storage");
    expect(storageIdx).toBeGreaterThan(-1);
    const storageSlice = html.slice(storageIdx, storageIdx + 300);
    expect(storageSlice).toContain("reported at publish");
    // It must NOT contain the live-verified phrasing that main.ts injects on a
    // successful live fetch ("verified live against 0G").
    expect(storageSlice).not.toContain("verified live against 0G");
    // It must NOT carry the data-sidecar-reported marker alongside a bold ✓.
    expect(storageSlice).not.toContain("✓");
  });
});

describe("deriveSummary attested fields (TEE provenance pre-click)", () => {
  // A minimal valid bundle whose verifierSummary is an attested 0g-compute run.
  // hx() and baseBundle are defined near the top of this file.
  function attestedBundle(verdicts: Array<"substantiated" | "inflated" | "unsupported">): PublicLedgerBundle {
    const badges = verdicts.map((v, i) => ({
      claimId: `claim:c${i}`,
      status: v === "substantiated" ? "verified" : v === "inflated" ? "partial" : "unsupported",
      confidence: 0.8,
      supportingNodes: v === "unsupported" ? [] : [`file:src/c${i}.ts`],
      publicExplanation: "merged badge",
      provenance: "structural+attested",
      verdict: v
    }));
    return {
      ...JSON.parse(JSON.stringify(baseBundle)),
      verifierSummary: {
        verifierId: "vibetrace-0g-compute-adjudicator",
        provider: "0g-compute",
        model: "tee-llm",
        requestHash: hx("5"),
        responseHash: hx("6"),
        outputHash: hx("7"),
        createdAt: "2026-06-17T10:00:00.000Z",
        summary: "Attested adjudication",
        evidenceTier: "public-only",
        // CANONICAL per-claim verdicts under the tamper hash — the source deriveAttestedFields reads
        // (matches real bundles, where merge.ts mirrors these into evidenceBadges).
        verdicts: verdicts.map((v, i) => ({ claimId: `claim:c${i}`, verdict: v })),
        attestation: {
          scheme: "0g-teeml",
          attests: "tee-execution",
          providerAddress: "0xprovider",
          // REAL recovering material so the (now recovery-gated) display predicate passes.
          signingAddress: TEST_SIGNING_ADDRESS,
          signature: TEST_SIGNATURE,
          signedDigest: TEST_SIGNED_DIGEST,
          responseTextHash: hx("f"),
          processResponseValid: true,
          verifiedAt: "2026-06-17T10:00:00.000Z",
          verifiedBy: "relayer"
        }
      },
      evidenceBadges: badges
    } as unknown as PublicLedgerBundle;
  }

  it("flags teeVerified for a TEE-execution-attested 0g-compute run", async () => {
    const summary = await deriveSummary(attestedBundle(["substantiated"]), "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(true);
    expect(summary.attestedVerdict).toBe("substantiated");
    expect(summary.substantiatedClaims).toBe(1);
  });

  it("LEGACY: a run MISSING attestation.attests is NOT shown as teeVerified (degrades gracefully)", async () => {
    const bundle = attestedBundle(["substantiated"]);
    // Simulate a legacy bundle written before the `attests` field existed.
    delete (bundle.verifierSummary as { attestation?: { attests?: unknown } }).attestation!.attests;
    const summary = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(false);
    // The verdict headline still derives (verdicts are present) — only the TEE flag is withheld.
    expect(summary.attestedVerdict).toBe("substantiated");
  });

  // RECOVERY GATE: a shape-valid attestation whose signature does NOT recover to signingAddress
  // is NOT teeVerified → no ◆ 0G·TEE pill on the leaderboard row. The forgeable shape-only path is closed.
  it("RECOVERY GATE: a NON-RECOVERING attestation is NOT teeVerified (no ◆ 0G·TEE pill)", async () => {
    const bundle = attestedBundle(["substantiated"]);
    // Substitute the signer so recovery fails (the rest of the shape is still valid).
    (bundle.verifierSummary as unknown as { attestation: Record<string, unknown> }).attestation.signingAddress =
      "0x" + "0".repeat(40);
    const summary = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(false);
    const html = renderLeaderboard([summary]);
    expect(html).not.toContain("tee-pill");
    expect(html).not.toContain("0G·TEE");
    // The verdict headline still derives from the per-claim verdicts.
    expect(summary.attestedVerdict).toBe("substantiated");
  });

  it("reports the WORST verdict as the headline attestedVerdict", async () => {
    const summary = await deriveSummary(
      attestedBundle(["substantiated", "inflated", "substantiated"]),
      "2026-06-17T16:08:00.000Z"
    );
    expect(summary.attestedVerdict).toBe("inflated");
    expect(summary.substantiatedClaims).toBe(2);
    const worse = await deriveSummary(
      attestedBundle(["substantiated", "unsupported"]),
      "2026-06-17T16:08:00.000Z"
    );
    expect(worse.attestedVerdict).toBe("unsupported");
  });

  it("is NOT teeVerified for a local/unattested run (provider !== 0g-compute)", async () => {
    // baseBundle's verifierSummary is the local 0g-dev run with no attestation.
    const summary = await deriveSummary(baseBundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(false);
    expect(summary.attestedVerdict).toBe(null);
    expect(summary.substantiatedClaims).toBe(0);
  });

  // deriveAttestedFields fails closed on a 0G read-back mismatch, exactly like the
  // story-page seal cracks. A shape-valid TEE attestation whose verifyAgainst0G sidecar shows
  // storage OR chain matches===false is NOT teeVerified, and therefore renders NO ◆ 0G·TEE pill.
  function withSidecar(
    bundle: PublicLedgerBundle,
    storageMatches: boolean,
    chainMatches: boolean
  ): PublicLedgerBundle {
    return {
      ...bundle,
      verifyAgainst0G: {
        storage: { rootHash: hx("8"), recomputedHash: hx("8"), matches: storageMatches },
        chain: {
          txHash: hx("9"),
          calldataManifestHash: hx("a"),
          expectedManifestHash: hx("a"),
          matches: chainMatches,
          readAt: "2026-06-17T10:00:00.000Z"
        }
      }
    } as PublicLedgerBundle;
  }

  it("FAILS CLOSED: an attested run with a verifyAgainst0G STORAGE mismatch is NOT teeVerified", async () => {
    const bundle = withSidecar(attestedBundle(["substantiated"]), false, true);
    const summary = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(false);
    // the leaderboard row must NOT carry the TEE pill for a downgraded entry
    const html = renderLeaderboard([summary]);
    expect(html).not.toContain("tee-pill");
    expect(html).not.toContain("0G·TEE");
  });

  it("FAILS CLOSED: an attested run with a verifyAgainst0G CHAIN mismatch is NOT teeVerified (no ◆ 0G·TEE pill)", async () => {
    const bundle = withSidecar(attestedBundle(["substantiated"]), true, false);
    const summary = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(false);
    const html = renderLeaderboard([summary]);
    expect(html).not.toContain("tee-pill");
    expect(html).not.toContain("0G·TEE");
  });

  it("a matched verifyAgainst0G sidecar (both matches true) stays teeVerified", async () => {
    const bundle = withSidecar(attestedBundle(["substantiated"]), true, true);
    const summary = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(true);
  });
});

describe("stale-summary bypass: persisted teeVerified is re-derived on load", () => {
  // Build a fully shape-valid attested 0g-compute bundle whose signature does NOT
  // recover to signingAddress (a forger substituted the signer). deriveAttestedFields
  // MUST treat it as NOT TEE-attested. The point of the test: a row PERSISTED with a
  // stale/forged teeVerified:true (e.g. written before the recovery gate existed, or
  // hand-edited on disk) must be corrected to false when createStore() loads it —
  // never trusting the stored summary value.
  function nonRecoveringAttestedBundle(): PublicLedgerBundle {
    const bundle = JSON.parse(JSON.stringify(baseBundle)) as PublicLedgerBundle;
    (bundle as unknown as { verifierSummary: Record<string, unknown> }).verifierSummary = {
      verifierId: "vibetrace-0g-compute-adjudicator",
      provider: "0g-compute",
      model: "tee-llm",
      requestHash: hx("5"),
      responseHash: hx("6"),
      outputHash: hx("7"),
      createdAt: "2026-06-17T10:00:00.000Z",
      summary: "Attested adjudication",
      evidenceTier: "public-only",
      verdicts: [{ claimId: "claim:c0", verdict: "substantiated" }],
      attestation: {
        scheme: "0g-teeml",
        attests: "tee-execution",
        providerAddress: "0xprovider",
        // SHAPE-valid signature/digest BUT the signer is substituted, so
        // recoverAddress(signedDigest, signature) !== signingAddress.
        signingAddress: "0x" + "0".repeat(40),
        signature: TEST_SIGNATURE,
        signedDigest: TEST_SIGNED_DIGEST,
        responseTextHash: hx("f"),
        processResponseValid: true,
        verifiedAt: "2026-06-17T10:00:00.000Z",
        verifiedBy: "relayer"
      }
    };
    return bundle;
  }

  it("a persisted entry with forged teeVerified:true (non-recovering attestation) is corrected to false on load — no pill, no marquee mark", async () => {
    const bundle = nonRecoveringAttestedBundle();
    // The HONEST summary already computes teeVerified:false (recovery fails)…
    const honest = await deriveSummary(bundle, "2026-06-17T16:08:00.000Z");
    expect(honest.teeVerified).toBe(false);

    // …but we persist a FORGED row that claims teeVerified:true (and a stale
    // attestedVerdict/substantiatedClaims, as a bypass that trusts the stored value would carry).
    const forgedEntry = {
      ...honest,
      teeVerified: true,
      attestedVerdict: "substantiated" as const,
      substantiatedClaims: 1,
      bundle
    };
    const storePath = join(tmpdir(), `vt-stale-${Date.now()}-${Math.random()}.json`);
    writeJsonFileAtomic(storePath, [forgedEntry]);

    try {
      // Load through the real entry point. seedDir points at a non-existent dir so the
      // ONLY entry is our persisted forged row (no seeding interference).
      const store = await createStore({
        storePath,
        seedDir: join(tmpdir(), `vt-no-seed-${Date.now()}-${Math.random()}`)
      });
      expect(store.entries.length).toBe(1);
      const loaded = store.entries[0];

      // The forged teeVerified:true is CORRECTED to false by re-derivation on load.
      expect(loaded.teeVerified).toBe(false);

      // No leaderboard ◆ 0G·TEE pill and no marquee TEE mark for the corrected row.
      const summary = (() => {
        const { bundle: _b, ...s } = loaded;
        return s;
      })();
      const board = renderLeaderboard([summary]);
      expect(board).not.toContain("tee-pill");
      expect(board).not.toContain("0G·TEE");

      const marquee = renderMarqueeBar([summary]);
      expect(marquee).not.toContain('data-tee="1"');
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("a persisted entry whose bundle is missing/malformed fails closed to teeVerified:false on load", async () => {
    const storePath = join(tmpdir(), `vt-stale-nobundle-${Date.now()}-${Math.random()}.json`);
    // A forged row claiming teeVerified:true but with NO usable bundle to re-derive from.
    writeJsonFileAtomic(storePath, [
      { id: "x", repo: "repo/x", teeVerified: true, seal: "self-published", bundle: { not: "a bundle" } }
    ]);
    try {
      const store = await createStore({
        storePath,
        seedDir: join(tmpdir(), `vt-no-seed-${Date.now()}-${Math.random()}`)
      });
      expect(store.entries.length).toBe(1);
      expect(store.entries[0].teeVerified).toBe(false);
    } finally {
      rmSync(storePath, { force: true });
    }
  });
});

describe("attested fields survive store seed + /api/registry round-trip", () => {
  it("every summary row exposes teeVerified/attestedVerdict/substantiatedClaims", async () => {
    const store = await createStore({
      storePath: join(tmpdir(), `vt-attested-${Date.now()}-${Math.random()}.json`)
    });
    const res = await handleRegistry(store);
    expect(res.status).toBe(200);
    const rows = JSON.parse(res.body) as RegistrySummary[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(typeof row.teeVerified).toBe("boolean");
      expect(typeof row.substantiatedClaims).toBe("number");
      // null is allowed; otherwise it is one of the three verdict words.
      expect([null, "substantiated", "inflated", "unsupported"]).toContain(row.attestedVerdict);
    }
  });
});

describe("marquee flags TEE-attested builds (pre-click)", () => {
  function row(over: Partial<RegistrySummary>): RegistrySummary {
    return {
      id: "id",
      project: "P",
      repo: "repo/p",
      tools: [],
      vibeScore: 70,
      tier: "B",
      tierLabel: "B",
      seal: "anchored-verified",
      anchored: true,
      scoreVersion: 2,
      buildScore: 80,
      buildTier: "A",
      buildTierLabel: "Heavily AI-Built",
      proofLabel: "Anchored on 0G · independently examined",
      proofRank: 5,
      trustWeightedScore: 70,
      fileCount: 3,
      verifiedClaims: 2,
      teeVerified: false,
      attestedVerdict: null,
      substantiatedClaims: 0,
      submittedAt: "2026-06-17T16:08:00.000Z",
      bundleHash: "0x" + "a".repeat(64),
      ...over
    };
  }

  it("marks attested rows with data-tee and a wax dot, unattested without", () => {
    const attested = renderLiveMarquee([
      row({ id: "att", teeVerified: true, attestedVerdict: "substantiated", substantiatedClaims: 2 })
    ]);
    expect(attested).toContain('data-tee="1"');
    expect(attested).toContain("text-wax");

    const plain = renderLiveMarquee([row({ id: "plain", teeVerified: false })]);
    expect(plain).not.toContain('data-tee="1"');
  });
});

/* ── 0G TEE-execution UI: band + rim + examiner + pill + attestation metadata ── */

describe("0G TEE-execution UI (exposure + inspection, honest)", () => {
  function teeRow(over: Partial<RegistrySummary>): RegistrySummary {
    return {
      id: "id",
      project: "P",
      repo: "repo/p",
      tools: [],
      vibeScore: 70,
      tier: "B",
      tierLabel: "B",
      seal: "anchored-verified",
      anchored: true,
      scoreVersion: 2,
      buildScore: 80,
      buildTier: "A",
      buildTierLabel: "Heavily AI-Built",
      proofLabel: "Anchored on 0G · independently examined",
      proofRank: 5,
      trustWeightedScore: 70,
      fileCount: 3,
      verifiedClaims: 2,
      teeVerified: false,
      attestedVerdict: null,
      substantiatedClaims: 0,
      submittedAt: "2026-06-17T16:08:00.000Z",
      bundleHash: "0x" + "a".repeat(64),
      ...over
    };
  }

  it("leaderboard renders the ◆ 0G·TEE pill ONLY for a teeVerified, non-broken row", () => {
    const attested = renderLeaderboard([teeRow({ id: "att", teeVerified: true })]);
    expect(attested).toContain("tee-pill");
    expect(attested).toContain("◆");
    expect(attested).toContain("0G·TEE");
    expect(attested).toContain("open the story to inspect the signer and receipt");

    const plain = renderLeaderboard([teeRow({ id: "plain", teeVerified: false })]);
    expect(plain).not.toContain("tee-pill");
    expect(plain).not.toContain("0G·TEE");
  });

  it("leaderboard FAILS CLOSED: a teeVerified row with a broken seal shows NO pill", () => {
    const broken = renderLeaderboard([teeRow({ id: "brk", teeVerified: true, seal: "broken" })]);
    expect(broken).not.toContain("tee-pill");
    expect(broken).not.toContain("0G·TEE");
  });

  it("story page renders the hero band + 0G TEE rim + examiner strip + attestation metadata", () => {
    const bundle = attestedBundle();
    const score = scoreBundle(bundle);
    const html = renderBundle(bundle, score);
    // hero band
    expect(html).toContain("tee-band");
    expect(html).toContain("Independently examined by a 0G TEE enclave");
    expect(html).toContain("execution attested · examined by the provider's 0G TEE signer · verdict relayed by the operator");
    // seal rim
    expect(html).toContain("0G TEE EXAMINED");
    // examiner strip — honest line 3 + the non-"verify" signer label
    expect(html).toContain("examiner-card");
    expect(html).toContain("Examined by a 0G TEE enclave");
    expect(html).toContain("the enclave does not sign the verdict");
    expect(html).toContain("view signer on 0GScan");
    // attestation metadata block
    expect(html).toContain("Attestation");
    expect(html).toContain("0g-teeml");
    expect(html).toContain("tee-execution");
    // compact recover-check CTA replaces the old prose paragraphs.
    expect(html).toContain("recoverAddress(signedDigest, signature) === signingAddress");
    // verifiedAt is humanized (relative date) with a clock line, not a raw ISO field
    // labelled "verifiedAt". The relative phrase is clock-robust ("…ago" or "just now").
    expect(html).toMatch(/verified (just now|\d+[mhd] ago) by/);
    expect(html).not.toContain("verifiedAt");
    // the ◆ diamond mark, not a generic checkmark
    expect(html).toContain("◆");
  });

  it("graceful degrade: a non-attested (structural-only) bundle renders NONE of the TEE UI and never throws", () => {
    const bundle = anchoredBundle(); // 0g-router, no attestation → structural-only
    const score = scoreBundle(bundle);
    let html = "";
    expect(() => {
      html = renderBundle(bundle, score);
    }).not.toThrow();
    expect(html).not.toContain("tee-band");
    expect(html).not.toContain("examiner-card");
    expect(html).not.toContain("0G TEE EXAMINED");
    expect(html).not.toContain("Independently examined by a 0G TEE enclave");
    expect(html).not.toContain("recoverAddress(signedDigest, signature)");
  });

  it("graceful degrade: a CRACKED attestation renders NONE of the TEE band/strip/metadata", () => {
    const bundle = attestedBundle({ processResponseValid: false });
    const score = scoreBundle(bundle);
    let html = "";
    expect(() => {
      html = renderBundle(bundle, score);
    }).not.toThrow();
    expect(html).toContain("SEAL UNVERIFIED");
    expect(html).not.toContain("tee-band");
    expect(html).not.toContain("examiner-card");
    expect(html).not.toContain("0G TEE EXAMINED");
  });

  it("the seeded real sample renders seal.kind==='attested' (not cracked) and teeVerified=true", async () => {
    const sample = JSON.parse(
      readFileSync(join(SEED_DIR, "attested-anchored-sample.json"), "utf8")
    ) as PublicLedgerBundle;
    const state = sealState(sample, verifyBundleHash(sample));
    expect(state.kind).toBe("attested");
    // teeVerified is derived by the SHARED registry-core path (the one the seed uses).
    const summary = await deriveSummary(sample, "2026-06-17T16:08:00.000Z");
    expect(summary.teeVerified).toBe(true);
    // and the story page renders the full treatment for the REAL bundle
    const html = renderBundle(sample, scoreBundle(sample));
    expect(html).toContain("tee-band");
    expect(html).toContain("examiner-card");
    expect(html).toContain("0G TEE EXAMINED");
    expect(html).toContain("0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF");
  });
});
