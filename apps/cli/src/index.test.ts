import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash, hashPublicLedgerBundle } from "@vibetrace/schema";
import type { ClaimVerdict, VerifierRun, EvidenceBadge, PublicLedgerBundle } from "@vibetrace/schema";
import {
  addBadgeToReadme,
  assertRelayerReceipt,
  augmentEvidenceBadgesForPublish,
  matchesIgnore,
  migrateLedgerProjectName,
  publishViaRelayer,
  resolveProjectName,
  runCli
} from "./index";
import { assemblePrivatePacket } from "./private-packet";

describe("addBadgeToReadme", () => {
  const block = (alt: string) =>
    `<!-- vibetrace-badge -->\n[![${alt}](http://x/api/badge/abc.svg)](http://x/#/p/abc)\n<!-- /vibetrace-badge -->`;

  it("inserts after the H1, updates in place on re-run, and creates a README when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-badge-"));
    try {
      await writeFile(join(dir, "README.md"), "# My Project\n\nA thing I built.\n");

      const r1 = await addBadgeToReadme(dir, block("VibeScore S"));
      expect(r1.created).toBe(false);
      let content = await readFile(join(dir, "README.md"), "utf8");
      expect(content).toContain("VibeScore S");
      // inserted AFTER the H1, not before it
      expect(content.indexOf("# My Project")).toBeLessThan(content.indexOf("vibetrace-badge"));

      // re-run UPDATES in place (one marker pair, new tier, old gone) — never duplicates
      await addBadgeToReadme(dir, block("VibeScore A"));
      content = await readFile(join(dir, "README.md"), "utf8");
      expect((content.match(/vibetrace-badge -->/g) ?? []).length).toBe(2);
      expect(content).toContain("VibeScore A");
      expect(content).not.toContain("VibeScore S");

      // create-if-missing
      await rm(join(dir, "README.md"));
      const r3 = await addBadgeToReadme(dir, block("VibeScore S"));
      expect(r3.created).toBe(true);
      expect(await readFile(join(dir, "README.md"), "utf8")).toContain("vibetrace-badge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("vibetrace CLI", () => {
  it("initializes, imports traces, verifies, and publishes a redacted public bundle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-cli-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const storage = '0g storage';\n");
    await writeFile(
      join(cwd, "trace.json"),
      JSON.stringify([
        {
          spanId: "span-1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T10:00:00.000Z",
          endedAt: "2026-06-17T10:02:00.000Z",
          promptHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          promptExcerpt: "private prompt",
          filesMentioned: ["src.ts"],
          artifactsProduced: ["src.ts"],
          metadata: {}
        }
      ])
    );

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["import", "--file", "trace.json"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined
    });
    await runCli(["verify"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["publish", "--public-summary"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined
    });

    const published = JSON.parse(await readFile(join(cwd, ".vibetrace", "published.json"), "utf8"));
    const publicBundle = JSON.parse(
      await readFile(join(cwd, ".vibetrace", "public", `${published.publicBundleHash}.json`), "utf8")
    );

    expect(publicBundle.manifest.publicBundleHash).toBe(published.publicBundleHash);
    expect(JSON.stringify(publicBundle)).not.toContain("private prompt");
    expect(publicBundle.storageAnchor.uri).toMatch(/^0g:\/\/local\//);
    expect(publicBundle.chainAnchor.manifestHash).toBe(published.publicBundleHash);
  });

  it("bootstraps an existing repo with shareable config and private ledger ignores", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-init-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "repo-owner-app" }));

    await runCli(["init", "--ci"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const config = JSON.parse(await readFile(join(cwd, "vibetrace.config.json"), "utf8"));
    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    const workflow = await readFile(join(cwd, ".github", "workflows", "vibetrace.yml"), "utf8");

    expect(config.schemaVersion).toBe("vibetrace.config.v1");
    expect(config.project.name).toBe("repo-owner-app");
    expect(config.snapshot.ignore).toContain(".env*");
    expect(config.traces.include).toContain(".agenttrace/*.json");
    expect(config.publish.publicBundlePath).toBe("public/vibetrace.json");
    expect(gitignore).toContain(".vibetrace/");
    expect(workflow).toContain("pnpm exec vibetrace ci");
    expect(workflow).not.toContain("vibetrace snapshot");
  });

  it("generates a package-manager native CI workflow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-npm-init-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "npm-owner-app" }));
    await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "npm-owner-app", lockfileVersion: 3 }));

    await runCli(["init", "--ci"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const workflow = await readFile(join(cwd, ".github", "workflows", "vibetrace.yml"), "utf8");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npx vibetrace ci");
    expect(workflow).not.toContain("pnpm/action-setup");
  });

  it("gives a clear next step before the workspace is initialized", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-uninit-"));
    await expect(runCli(["snapshot"], { cwd, stdout: () => undefined })).rejects.toThrow(
      "No VibeTrace workspace found. Run vibetrace init first."
    );
  });

  it("respects configured snapshot ignore patterns", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-ignore-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "fixtures"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "ignore-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(join(cwd, "fixtures", "large.json"), "{\"fixture\":true}\n");

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    const configPath = join(cwd, "vibetrace.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.snapshot.ignore.push("fixtures/**");
    await writeFile(configPath, JSON.stringify(config, null, 2));

    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    const files = ledger.snapshots[0].files.map((file: { path: string }) => file.path);
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain("fixtures/large.json");
  });

  it("uses the captured file set for no-git snapshot commit fallback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-no-git-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "no-git-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const traced = true;\n");

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    const snapshot = ledger.snapshots[0];
    expect(snapshot.branch).toBe("no-git");
    expect(snapshot.commit).toBe(canonicalHash(snapshot.files).slice(0, 14));
  });

  it("reports integration readiness through doctor --json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-doctor-"));
    const output: string[] = [];
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "doctor-fixture" }));
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["doctor", "--json"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: (message) => output.push(message),
      env: { VIBETRACE_OG_MODE: "real" }
    });

    const report = JSON.parse(output.join("\n"));
    expect(report.workspaceInitialized).toBe(true);
    expect(report.configFound).toBe(true);
    expect(report.packageDetected).toBe(true);
    expect(report.mode).toBe("real");
    // Self-hosted real mode (NO relayer) self-funds the anchor + storage → needs the client key.
    expect(report.missingEnv).toContain("VIBETRACE_0G_PRIVATE_KEY");
    // The funded compute key is relayer-side ONLY; npx vibetrace never needs it.
    expect(report.missingEnv).not.toContain("VIBETRACE_0G_COMPUTE_PRIVATE_KEY");
    // Without a relayer the user opted to self-host the writes, so the relayer URL is not a hard requirement here.
    expect(report.missingEnv).not.toContain("VIBETRACE_RELAYER_URL");
    expect(report.nextSteps).toContain("Run vibetrace ci to record, verify, and publish the current build story.");
  });

  it("doctor: a HOSTED relayer needs NO client funded key", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-doctor-hosted-"));
    const output: string[] = [];
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "hosted-fixture" }));
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["doctor", "--json"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: (message) => output.push(message),
      // The hosted path: a relayer URL is set. The relayer funds anchor + storage + compute.
      env: { VIBETRACE_OG_MODE: "real", VIBETRACE_RELAYER_URL: "https://relay.example" }
    });

    const report = JSON.parse(output.join("\n"));
    // With a relayer, every funded 0G write is relayer-side — the CLI needs NO key of its own.
    expect(report.missingEnv).not.toContain("VIBETRACE_0G_PRIVATE_KEY");
    expect(report.missingEnv).not.toContain("VIBETRACE_0G_COMPUTE_PRIVATE_KEY");
    expect(report.missingEnv).toEqual([]);
  });

  it("reports real-chain readiness separately from dev mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-doctor-real-chain-"));
    const output: string[] = [];
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "real-chain-fixture" }));
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["doctor", "--json"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: (message) => output.push(message),
      env: {
        VIBETRACE_OG_MODE: "real-chain",
        VIBETRACE_0G_PRIVATE_KEY: "0x" + "1".repeat(64),
        VIBETRACE_0G_RPC_URL: "https://evmrpc-testnet.0g.ai"
      }
    });

    const report = JSON.parse(output.join("\n"));
    expect(report.mode).toBe("real-chain");
    expect(report.missingEnv).not.toContain("VIBETRACE_0G_STORAGE_INDEXER");
    // Self-hosted real-chain with the client key + RPC provided → nothing missing. The relayer URL is
    // NOT a hard requirement (no relayer ⇒ compute degrades to structural-only, by the user's choice).
    expect(report.missingEnv).not.toContain("VIBETRACE_RELAYER_URL");
    expect(report.missingEnv).toEqual([]);
    // The funded ledger key is relayer-side ONLY; npx vibetrace never needs it.
    expect(report.missingEnv).not.toContain("VIBETRACE_0G_COMPUTE_PRIVATE_KEY");
  });

  it("upgrades 0G evidence badges only when live providers back them", () => {
    const badges = [
      {
        claimId: "claim:claim-0g-storage",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      },
      {
        claimId: "claim:claim-0g-compute",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      }
    ];

    const dev = augmentEvidenceBadgesForPublish(badges, {
      storageProvider: "0g-dev",
      verifierProvider: "0g-dev",
      verifierModel: "deterministic-lineage-verifier"
    });
    expect(dev.map((badge) => badge.status)).toEqual(["unsupported", "unsupported"]);

    const live = augmentEvidenceBadgesForPublish(badges, {
      storageProvider: "0g-storage",
      verifierProvider: "0g-compute",
      verifierModel: "tee-llm",
      attested: true
    });
    expect(live.map((badge) => badge.status)).toEqual(["verified", "verified"]);
    expect(live[0].supportingNodes).toContain("anchor:storage:0g-storage");
    expect(live[1].supportingNodes).toContain("verifier:0g-compute:tee-llm");

    // The dead "0g-router" string must NO LONGER upgrade the compute badge.
    const router = augmentEvidenceBadgesForPublish(badges, {
      storageProvider: "0g-storage",
      verifierProvider: "0g-router",
      verifierModel: "llama",
      attested: true
    });
    expect(router[1].status).toBe("unsupported");
  });

  it("upgrades the claim-tee-attested badge only under an attested 0g-compute run", () => {
    const badges = [
      {
        claimId: "claim:claim-tee-attested",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      }
    ];

    const dev = augmentEvidenceBadgesForPublish(badges, {
      verifierProvider: "0g-dev",
      verifierModel: "deterministic-lineage-verifier"
    });
    expect(dev[0].status).toBe("unsupported");

    const attested = augmentEvidenceBadgesForPublish(badges, {
      verifierProvider: "0g-compute",
      verifierModel: "tee-llm",
      attested: true
    });
    expect(attested[0].status).toBe("verified");
    expect(attested[0].supportingNodes).toContain("attestation:0g-teeml:tee-llm");
    expect(attested[0].publicExplanation).toContain("enclave");
  });

  it("does NOT upgrade compute/TEE badges from the provider string alone — requires attested=true", () => {
    const badges = [
      {
        claimId: "claim:claim-0g-compute",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      },
      {
        claimId: "claim:claim-tee-attested",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      },
      {
        claimId: "claim:claim-0g-storage",
        status: "unsupported" as const,
        confidence: 0,
        supportingNodes: [],
        publicExplanation: "No support."
      }
    ];

    // Provider says "0g-compute" but there is NO validated attestation (attested:false): a hostile/buggy
    // relayer setting only the provider string must NOT promote compute/TEE to verified.
    const noAtt = augmentEvidenceBadgesForPublish(badges, {
      storageProvider: "0g-storage",
      verifierProvider: "0g-compute",
      verifierModel: "m",
      attested: false
    });
    expect(noAtt.find((b) => b.claimId === "claim:claim-0g-compute")!.status).toBe("unsupported");
    expect(noAtt.find((b) => b.claimId === "claim:claim-tee-attested")!.status).toBe("unsupported");
    // Storage upgrade is INDEPENDENT of `attested` (anchored by the storage provider, not the TEE).
    expect(noAtt.find((b) => b.claimId === "claim:claim-0g-storage")!.status).toBe("verified");

    // With a validated attestation (attested:true), the compute/TEE upgrade is allowed.
    const withAtt = augmentEvidenceBadgesForPublish(badges, {
      storageProvider: "0g-storage",
      verifierProvider: "0g-compute",
      verifierModel: "m",
      attested: true
    });
    expect(withAtt.find((b) => b.claimId === "claim:claim-0g-compute")!.status).toBe("verified");
    expect(withAtt.find((b) => b.claimId === "claim:claim-tee-attested")!.status).toBe("verified");
  });

  it("exports a public bundle to a user supplied static path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-out-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "out-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const storage = '0g storage';\n");
    await writeFile(
      join(cwd, "trace.json"),
      JSON.stringify([
        {
          spanId: "span-1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T10:00:00.000Z",
          endedAt: "2026-06-17T10:02:00.000Z",
          promptHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          filesMentioned: ["src/index.ts"],
          artifactsProduced: ["src/index.ts"],
          metadata: {}
        }
      ])
    );

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["import", "--file", "trace.json"], { cwd, stdout: () => undefined });
    await runCli(["verify"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["publish", "--public-summary", "--out", "public/vibetrace.json"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined
    });

    const exported = JSON.parse(await readFile(join(cwd, "public", "vibetrace.json"), "utf8"));
    const published = JSON.parse(await readFile(join(cwd, ".vibetrace", "published.json"), "utf8"));
    expect(exported.manifest.publicBundleHash).toBe(published.publicBundleHash);
  });

  it("runs the low-touch CI flow with auto-discovered trace files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-ci-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, ".agenttrace"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "ci-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const traced = true;\n");
    await writeFile(
      join(cwd, ".agenttrace", "codex.json"),
      JSON.stringify({
        spans: [
          {
            spanId: "span-1",
            tool: "codex",
            model: "gpt-5",
            startedAt: "2026-06-17T10:00:00.000Z",
            endedAt: "2026-06-17T10:02:00.000Z",
            promptHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            promptExcerpt: "private prompt",
            filesMentioned: ["src/index.ts"],
            artifactsProduced: ["src/index.ts"],
            metadata: {}
          }
        ]
      })
    );

    await runCli(["ci"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["ci"], { cwd, now: () => "2026-06-17T10:05:00.000Z", stdout: () => undefined });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    const publicBundle = JSON.parse(await readFile(join(cwd, "public", "vibetrace.json"), "utf8"));
    const latestSnapshot = ledger.snapshots.at(-1);
    const latestFiles = latestSnapshot.files.map((file: { path: string }) => file.path);

    expect(ledger.traces).toHaveLength(1);
    expect(ledger.graph).toBeTruthy();
    expect(ledger.published.publicBundlePath).toBe("public/vibetrace.json");
    expect(publicBundle.manifest.publicBundleHash).toBe(ledger.published.publicBundleHash);
    expect(JSON.stringify(publicBundle)).not.toContain("private prompt");
    expect(latestFiles).toContain(".agenttrace/codex.json");
    expect(latestFiles).not.toContain("public/vibetrace.json");
  });

  it("HONESTY: a no-trace repo publishes claim-ai-build (and 0G claims) as unsupported", async () => {
    // A repo with a src/ file but ZERO AI traces must NOT earn a verified
    // AI-build badge from a path-glob alone. This is the exact honesty hole.
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-honest-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "honest-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const x = 1;\n");

    await runCli(["ci"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const bundle = JSON.parse(await readFile(join(cwd, "public", "vibetrace.json"), "utf8"));
    const aiBuild = bundle.evidenceBadges.find((b: EvidenceBadge) => b.claimId === "claim:claim-ai-build");
    expect(aiBuild?.status).toBe("unsupported");
    expect(aiBuild?.confidence).toBe(0);
    for (const id of ["claim:claim-0g-storage", "claim:claim-0g-compute", "claim:claim-tee-attested"]) {
      expect(bundle.evidenceBadges.find((b: EvidenceBadge) => b.claimId === id)?.status).toBe("unsupported");
    }
  });

  it("HONESTY: the same repo WITH a trace producing the src file verifies claim-ai-build", async () => {
    // The honest happy path: a real AI trace span that produced the src file
    // backs the AI-build claim, so the badge is verified (we didn't break it).
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-honest-trace-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, ".agenttrace"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "honest-trace-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const x = 1;\n");
    await writeFile(
      join(cwd, ".agenttrace", "codex.json"),
      JSON.stringify({
        spans: [
          {
            spanId: "span-1",
            tool: "codex",
            model: "gpt-5",
            startedAt: "2026-06-17T10:00:00.000Z",
            endedAt: "2026-06-17T10:02:00.000Z",
            promptHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            filesMentioned: ["src/index.ts"],
            artifactsProduced: ["src/index.ts"],
            metadata: {}
          }
        ]
      })
    );

    await runCli(["ci"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    const bundle = JSON.parse(await readFile(join(cwd, "public", "vibetrace.json"), "utf8"));
    const aiBuild = bundle.evidenceBadges.find((b: EvidenceBadge) => b.claimId === "claim:claim-ai-build");
    expect(aiBuild?.status).toBe("verified");
    expect(aiBuild?.supportingNodes.some((n: string) => n.startsWith("file:src/index.ts@"))).toBe(true);
  });
});

describe("verifyBundleAgainst0G", () => {
  it("round-trips dev 0G anchors: download+rehash matches, calldata matches", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { verifyBundleAgainst0G } = await import("./index");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-cli-v0g-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });

    const bundleContent = { manifest: { publicBundleHash: "0xabc" }, k: "v" };
    const storage = await adapters.storage.uploadJson(bundleContent);
    const bundleHash = canonicalHash(bundleContent);
    const chain = await adapters.chain.anchorManifest(bundleHash);

    const result = await verifyBundleAgainst0G(adapters, {
      storageRootHash: storage.rootHash,
      expectedStorageHash: storage.rootHash,
      chainTxHash: chain.txHash,
      expectedManifestHash: bundleHash,
      readAt: "2026-06-17T10:05:00.000Z"
    });

    expect(result.storage).toEqual({
      rootHash: storage.rootHash,
      recomputedHash: storage.rootHash,
      matches: true
    });
    expect(result.chain).toEqual({
      txHash: chain.txHash,
      calldataManifestHash: bundleHash,
      expectedManifestHash: bundleHash,
      matches: true,
      readAt: "2026-06-17T10:05:00.000Z"
    });
  });

  it("reports a mismatch (not a throw) when the expected manifest hash is wrong", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { verifyBundleAgainst0G } = await import("./index");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-cli-v0g-bad-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });

    const content = { a: 1 };
    const storage = await adapters.storage.uploadJson(content);
    const chain = await adapters.chain.anchorManifest(canonicalHash(content));

    const result = await verifyBundleAgainst0G(adapters, {
      storageRootHash: storage.rootHash,
      expectedStorageHash: storage.rootHash,
      chainTxHash: chain.txHash,
      expectedManifestHash: "0xWRONG",
      readAt: "2026-06-17T10:05:00.000Z"
    });

    expect(result.storage.matches).toBe(true);
    expect(result.chain.matches).toBe(false);
    expect(result.chain.calldataManifestHash).toBe(canonicalHash(content));
    expect(result.chain.expectedManifestHash).toBe("0xWRONG");
  });

  it("omits the signer leg when no signer input is supplied (dev path)", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { verifyBundleAgainst0G } = await import("./index");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-cli-v0g-nosig-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    const content = { a: 1 };
    const storage = await adapters.storage.uploadJson(content);
    const chain = await adapters.chain.anchorManifest(canonicalHash(content));
    const result = await verifyBundleAgainst0G(adapters, {
      storageRootHash: storage.rootHash,
      expectedStorageHash: storage.rootHash,
      chainTxHash: chain.txHash,
      expectedManifestHash: canonicalHash(content),
      readAt: "2026-06-17T10:05:00.000Z"
    });
    expect(result.signer).toBeUndefined();
  });

  it("attaches a signer leg from the supplied broker (real-compute path)", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { verifyBundleAgainst0G } = await import("./index");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-cli-v0g-sig-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    const content = { a: 1 };
    const storage = await adapters.storage.uploadJson(content);
    const chain = await adapters.chain.anchorManifest(canonicalHash(content));
    const SIGNER = "0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF";
    const broker = {
      inference: {
        listServiceWithDetail: async () => [
          { provider: "0xa48f", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: SIGNER, model: "m" }
        ],
        getServiceMetadata: async () => ({ endpoint: "", model: "" }),
        getRequestHeaders: async () => ({}),
        processResponse: async () => true,
        verifyService: async () => ({ composeVerification: { passed: true }, signerVerification: { allMatch: true } }),
        getSignerRaDownloadLink: async () => "",
        getChatSignatureDownloadLink: async () => ""
      }
    };
    const result = await verifyBundleAgainst0G(adapters, {
      storageRootHash: storage.rootHash,
      expectedStorageHash: storage.rootHash,
      chainTxHash: chain.txHash,
      expectedManifestHash: canonicalHash(content),
      readAt: "2026-06-17T10:05:00.000Z",
      signer: { broker: broker as any, providerAddress: "0xa48f", expectedSigner: SIGNER }
    });
    expect(result.signer).toMatchObject({ onChainSigner: SIGNER, acknowledgedOnChain: true, quoteVerified: true, matches: true });
  });

  it("performs the 0G read-back after publish and stashes VerifyAgainst0G outside the bundle hash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-cli-readback-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const storage = '0g storage';\n");
    await writeFile(
      join(cwd, "trace.json"),
      JSON.stringify([
        {
          spanId: "span-1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T10:00:00.000Z",
          endedAt: "2026-06-17T10:02:00.000Z",
          promptHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          filesMentioned: ["src.ts"],
          artifactsProduced: ["src.ts"],
          metadata: {}
        }
      ])
    );

    const opts = { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined };
    await runCli(["init"], opts);
    await runCli(["snapshot"], opts);
    await runCli(["import", "--file", "trace.json"], opts);
    await runCli(["verify"], opts);
    await runCli(["publish", "--public-summary"], opts);

    const published = JSON.parse(await readFile(join(cwd, ".vibetrace", "published.json"), "utf8"));
    const sidecar = JSON.parse(await readFile(join(cwd, ".vibetrace", "verify-against-0g.json"), "utf8"));

    // Round-trip succeeded against dev 0G.
    expect(sidecar.storage.matches).toBe(true);
    expect(sidecar.storage.recomputedHash).toBe(sidecar.storage.rootHash);
    expect(sidecar.chain.matches).toBe(true);
    expect(sidecar.chain.calldataManifestHash).toBe(sidecar.chain.expectedManifestHash);
    expect(published.verifyAgainst0G).toEqual(sidecar);

    // The public bundle JSON MUST carry the verifyAgainst0G sidecar.
    // But the sidecar is EXCLUDED from publicLedgerHashPayload (spec §10), so the
    // bundle's hash must be unchanged — verified by re-hashing the written bundle.
    const publicBundleParsed = JSON.parse(
      await readFile(join(cwd, ".vibetrace", "public", `${published.publicBundleHash}.json`), "utf8")
    );
    expect(publicBundleParsed.verifyAgainst0G).toEqual(sidecar);
    const { hashPublicLedgerBundle } = await import("@vibetrace/schema");
    expect(hashPublicLedgerBundle(publicBundleParsed)).toBe(published.publicBundleHash);
  });

  it("published bundle carries verifyAgainst0G sidecar and its hash is unchanged by it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-sidecar-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "sidecar-fixture" }));
    await writeFile(join(cwd, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(
      join(cwd, "trace.json"),
      JSON.stringify([
        {
          spanId: "span-1",
          tool: "codex",
          model: "gpt-5",
          startedAt: "2026-06-17T10:00:00.000Z",
          endedAt: "2026-06-17T10:02:00.000Z",
          promptHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          filesMentioned: ["src/index.ts"],
          artifactsProduced: ["src/index.ts"],
          metadata: {}
        }
      ])
    );

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["import", "--file", "trace.json"], { cwd, stdout: () => undefined });
    await runCli(["verify"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["publish", "--public-summary"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined
    });

    const published = JSON.parse(await readFile(join(cwd, ".vibetrace", "published.json"), "utf8"));
    const publicBundle = JSON.parse(
      await readFile(join(cwd, ".vibetrace", "public", `${published.publicBundleHash}.json`), "utf8")
    );

    // The sidecar must be present on the written bundle.
    expect(publicBundle.verifyAgainst0G).toBeDefined();
    expect(typeof publicBundle.verifyAgainst0G.storage.matches).toBe("boolean");
    expect(typeof publicBundle.verifyAgainst0G.chain.matches).toBe("boolean");

    // The bundle hash must NOT change when the sidecar is present
    // (verifyAgainst0G is excluded from publicLedgerHashPayload).
    const { hashPublicLedgerBundle } = await import("@vibetrace/schema");
    expect(hashPublicLedgerBundle(publicBundle)).toBe(published.publicBundleHash);
  });
});

describe("reverifyPublishedBundle (npx vibetrace verify <bundle.json>)", () => {
  const SIGNER = "0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF";

  it("dev-anchor bundle → reports nothing to re-fetch, returns true (honest degradation)", async () => {
    const { reverifyPublishedBundle } = await import("./index");
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-reverify-dev-"));
    const file = join(dir, "bundle.json");
    await writeFile(file, JSON.stringify({
      storageAnchor: { provider: "0g-dev", rootHash: "0xabc" },
      manifest: { publicBundleHash: "0xdef" },
      publicGraph: { nodes: [], edges: [], redactionPolicy: "private-by-default", canonicalHash: "0x" },
      verifierSummary: { provider: "0g-dev", model: "m" },
      evidenceBadges: []
    }));
    const out: string[] = [];
    const ok = await reverifyPublishedBundle(file, {} as NodeJS.ProcessEnv, (m) => out.push(m));
    expect(ok).toBe(true);
    expect(out.join("\n")).toMatch(/dev-anchor bundle/);
  });

  it("real-storage bundle that round-trips through 0G → PASS on storage + chain + signer", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { reverifyPublishedBundle } = await import("./index");
    const { publicLedgerHashPayload } = await import("@vibetrace/schema");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-reverify-real-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });

    const bundleCore = {
      manifest: {
        schemaVersion: "vibetrace.v1", project: { name: "x" }, repo: { root: "/", commit: "c" },
        createdAt: "2026-06-17T10:00:00.000Z", snapshotRoot: "0x", traceRoot: "0x", graphRoot: "0x",
        publicBundleHash: "pending", anchors: []
      },
      publicGraph: { nodes: [], edges: [], redactionPolicy: "private-by-default", canonicalHash: "0x" },
      verifierSummary: { provider: "0g-compute", model: "m", attestation: { providerAddress: "0xa48f", signingAddress: SIGNER } },
      evidenceBadges: []
    };
    // Upload exactly the content the producer would store, and anchor the manifest hash.
    const content = publicLedgerHashPayload(bundleCore as any);
    const storage = await adapters.storage.uploadJson(content);
    const manifestHash = canonicalHash(bundleCore);
    const chain = await adapters.chain.anchorManifest(manifestHash);

    const bundle = {
      ...bundleCore,
      manifest: { ...bundleCore.manifest, publicBundleHash: manifestHash },
      storageAnchor: { provider: "0g-storage", rootHash: storage.rootHash },
      chainAnchor: { txHash: chain.txHash }
    };
    const file = join(workspace, "bundle.json");
    await writeFile(file, JSON.stringify(bundle));

    const broker = {
      inference: {
        listServiceWithDetail: async () => [
          { provider: "0xa48f", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: SIGNER, model: "m" }
        ],
        getServiceMetadata: async () => ({ endpoint: "", model: "" }),
        getRequestHeaders: async () => ({}),
        processResponse: async () => true,
        verifyService: async () => ({ composeVerification: { passed: true }, signerVerification: { allMatch: true } }),
        getSignerRaDownloadLink: async () => "",
        getChatSignatureDownloadLink: async () => ""
      }
    };
    const out: string[] = [];
    const ok = await reverifyPublishedBundle(file, {} as NodeJS.ProcessEnv, (m) => out.push(m), { adapters, broker: broker as any });
    expect(ok).toBe(true);
    const text = out.join("\n");
    expect(text).toMatch(/RESULT: PASS/);
    expect(text).toMatch(/0G SIGNER.*IS the provider's/);
  });

  it("real-storage bundle with a FORGED signer → FAIL on the signer leg", async () => {
    const { createDevOgAdapters } = await import("@vibetrace/og");
    const { reverifyPublishedBundle } = await import("./index");
    const { publicLedgerHashPayload } = await import("@vibetrace/schema");
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-reverify-forge-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    const FORGED = "0x" + "9".repeat(40);
    const bundleCore = {
      manifest: { schemaVersion: "vibetrace.v1", project: { name: "x" }, repo: { root: "/", commit: "c" }, createdAt: "2026-06-17T10:00:00.000Z", snapshotRoot: "0x", traceRoot: "0x", graphRoot: "0x", publicBundleHash: "pending", anchors: [] },
      publicGraph: { nodes: [], edges: [], redactionPolicy: "private-by-default", canonicalHash: "0x" },
      verifierSummary: { provider: "0g-compute", model: "m", attestation: { providerAddress: "0xa48f", signingAddress: FORGED } },
      evidenceBadges: []
    };
    const content = publicLedgerHashPayload(bundleCore as any);
    const storage = await adapters.storage.uploadJson(content);
    const manifestHash = canonicalHash(bundleCore);
    const chain = await adapters.chain.anchorManifest(manifestHash);
    const bundle = { ...bundleCore, manifest: { ...bundleCore.manifest, publicBundleHash: manifestHash }, storageAnchor: { provider: "0g-storage", rootHash: storage.rootHash }, chainAnchor: { txHash: chain.txHash } };
    const file = join(workspace, "bundle.json");
    await writeFile(file, JSON.stringify(bundle));
    const broker = {
      inference: {
        listServiceWithDetail: async () => [{ provider: "0xa48f", verifiability: "TeeML", teeSignerAcknowledged: true, teeSignerAddress: SIGNER, model: "m" }],
        getServiceMetadata: async () => ({ endpoint: "", model: "" }),
        getRequestHeaders: async () => ({}),
        processResponse: async () => true,
        verifyService: async () => ({ composeVerification: { passed: true }, signerVerification: { allMatch: true } }),
        getSignerRaDownloadLink: async () => "",
        getChatSignatureDownloadLink: async () => ""
      }
    };
    const out: string[] = [];
    const ok = await reverifyPublishedBundle(file, {} as NodeJS.ProcessEnv, (m) => out.push(m), { adapters, broker: broker as any });
    expect(ok).toBe(false);
    expect(out.join("\n")).toMatch(/RESULT: FAIL/);
  });
});

describe("buildViewerUrl", () => {
  it("generates a registry story page URL (#/p/<hash>) not a ?bundle= 0g:// URI", async () => {
    const { buildViewerUrl } = await import("./index");
    const hash = "0xabc123def456" + "0".repeat(52);
    const url = buildViewerUrl("https://vibetrace.app", hash);
    expect(url).toBe(`https://vibetrace.app/#/p/${hash}`);
    expect(url).not.toContain("?bundle=");
    expect(url).not.toContain("0g://");
  });

  it("handles a base URL that already has a trailing slash", async () => {
    const { buildViewerUrl } = await import("./index");
    const hash = "0x" + "a".repeat(64);
    const url = buildViewerUrl("https://vibetrace.app/", hash);
    expect(url).toBe(`https://vibetrace.app/#/p/${hash}`);
    expect(url).not.toContain("?bundle=");
  });
});

describe("vibetrace private packet flow", () => {
  // the adjudicator carries verdicts on verifierRun.verdicts (not a top-level field).
  function abstainedRun(): { verifierRun: VerifierRun; evidenceBadges: EvidenceBadge[] } {
    const verdicts: ClaimVerdict[] = [
      {
        claimId: "claim:claim-ai-build",
        verdict: "unsupported",
        confidence: 0,
        supportingNodes: [],
        rationale: "no public evidence",
        abstainReason: "insufficient-public-evidence",
        dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
      }
    ];
    return {
      verifierRun: {
        verifierId: "vibetrace-attested-adjudicator",
        provider: "0g-compute",
        model: "tee-model",
        requestHash: "0x" + "1".repeat(64),
        responseHash: "0x" + "2".repeat(64),
        outputHash: "0x" + "3".repeat(64),
        createdAt: "2026-06-17T10:00:00.000Z",
        summary: "public-only",
        evidenceTier: "public-only",
        verdicts
      },
      evidenceBadges: []
    };
  }

  it("dry-runs (no packet sent) without --yes and prints the disclosure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-packet-dry-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    const out: string[] = [];
    let sentPacket = false;
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["verify", "--private-packet"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: (m) => out.push(m),
      adjudicate: async (input) => {
        if (input.privatePacket) sentPacket = true;
        const r = abstainedRun();
        return { verifierRun: r.verifierRun, evidenceBadges: r.evidenceBadges };
      }
    });
    const joined = out.join("\n");
    expect(joined).toContain("private packet");
    expect(joined.toLowerCase()).toContain("--yes");
    expect(sentPacket).toBe(false);
  });

  it("documents the --private-packet and --redact flags in help", async () => {
    const out: string[] = [];
    await runCli(["--help"], { stdout: (m) => out.push(m) });
    const help = out.join("\n");
    expect(help).toContain("--private-packet");
    expect(help).toContain("--redact");
  });

  it("sends the packet with --yes, records evidenceTier=private + privateEvidenceRoot, and upgrades the verdict", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-packet-yes-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    let seenRoot: string | undefined;
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      adjudicate: async (input) => {
        seenRoot = input.privateEvidenceRoot;
        const r = abstainedRun();
        const verdicts: ClaimVerdict[] = input.privatePacket
          ? [
              {
                claimId: "claim:claim-ai-build",
                verdict: "substantiated",
                confidence: 0.8,
                supportingNodes: ["file:src.ts"],
                rationale: "packet shows the work",
                abstainReason: null,
                dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
              }
            ]
          : (r.verifierRun.verdicts ?? []);
        return {
          verifierRun: { ...r.verifierRun, evidenceTier: "private", privateEvidenceRoot: input.privateEvidenceRoot, verdicts },
          evidenceBadges: r.evidenceBadges
        };
      }
    });
    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    expect(ledger.verifier.verifierRun.evidenceTier).toBe("private");
    expect(ledger.verifier.verifierRun.privateEvidenceRoot).toBe(seenRoot);
    expect(typeof seenRoot).toBe("string");
    // the merged verdict set is the FULL graph Claim baseline (every claim explicitly
    // represented), with claim-ai-build upgraded because the packet covers it (file:src.ts excerpt).
    const aiBuild = (ledger.verifier.verdicts as ClaimVerdict[]).find(
      (v) => v.claimId === "claim:claim-ai-build"
    );
    expect(aiBuild?.verdict).toBe("substantiated");
    // public receipt commitment is only the root, never the leaves
    expect(JSON.stringify(ledger.verifier)).not.toContain("export const x = 1;");
  });

  it("does NOT silently upgrade a claim that was publicly inflated (not abstained)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-upgrade-gate-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");

    // Public-only verdicts: the public-only verifier found the claim "inflated" (NOT abstained).
    const inflatedVerdict: ClaimVerdict = {
      claimId: "claim:claim-ai-build",
      verdict: "inflated",
      confidence: 0.3,
      supportingNodes: [],
      rationale: "oversold",
      abstainReason: null,
      dimensions: { relevance: "weak", sufficiency: "absent", contradiction: "none" }
    };

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    let adjudicateCalled = false;
    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      // verifierFn simulates the public-only run that sets verdicts in verifierRun.verdicts.
      // This is the seam that the upgrade gate reads from.
      verifierFn: async () => ({
        verifierRun: {
          verifierId: "vibetrace-attested-adjudicator",
          provider: "0g-compute",
          model: "tee-model",
          requestHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          outputHash: "0x" + "3".repeat(64),
          createdAt: "2026-06-17T10:00:00.000Z",
          summary: "public-only inflated",
          evidenceTier: "public-only",
          verdicts: [inflatedVerdict]
        },
        evidenceBadges: []
      }),
      adjudicate: async (input) => {
        adjudicateCalled = true;
        // Private run returns "substantiated" — the upgrade gate must block this
        // because the public run said "inflated" (not abstained).
        const verdicts: ClaimVerdict[] = [
          {
            claimId: "claim:claim-ai-build",
            verdict: "substantiated",
            confidence: 0.9,
            supportingNodes: ["file:src.ts"],
            rationale: "packet shows the work",
            abstainReason: null,
            dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
          }
        ];
        return {
          verifierRun: {
            verifierId: "vibetrace-attested-adjudicator",
            provider: "0g-compute",
            model: "tee-model",
            requestHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            outputHash: "0x" + "3".repeat(64),
            createdAt: "2026-06-17T10:00:00.000Z",
            summary: "private-tier",
            evidenceTier: "private",
            privateEvidenceRoot: input.privateEvidenceRoot,
            verdicts
          },
          evidenceBadges: []
        };
      }
    });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    expect(adjudicateCalled).toBe(true);
    // The claim was publicly "inflated", NOT abstained → upgrade gate must block it.
    // The gate reads verifierRun.verdicts (not ledger.verifier.verdicts which is empty before private run).
    expect(ledger.verifier.verdicts[0].verdict).toBe("inflated");
  });

  it("PRIVACY: a secret string in a private packet leaf/rationale never appears in the public bundle JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-privacy-leak-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");

    // A recognizable secret string that must NEVER appear in the public bundle.
    const SECRET = "SUPER_SECRET_PRIVATE_TOKEN_XYZ_12345_ABCDE";

    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      adjudicate: async (input) => {
        // Simulate a TEE run that echoes private evidence text in the rationale
        // (this is the exact leak scenario — private content bleeds into the result).
        const verdict: ClaimVerdict = {
          claimId: "claim:claim-ai-build",
          verdict: "substantiated",
          confidence: 0.9,
          supportingNodes: input.privatePacket
            ? (input.privatePacket as { leaves?: Array<{ id: string }> }).leaves?.map((l) => l.id) ?? []
            : [],
          // The TEE puts the secret (from the packet) in the rationale — this is the leak.
          rationale: `The packet shows: ${SECRET}`,
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        };
        return {
          verifierRun: {
            verifierId: "vibetrace-attested-adjudicator",
            provider: "0g-compute",
            model: "tee-model",
            requestHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            outputHash: "0x" + "3".repeat(64),
            createdAt: "2026-06-17T10:00:00.000Z",
            // Secret also in summary (leak scenario)
            summary: `Adjudicated. Evidence hint: ${SECRET}`,
            evidenceTier: "private",
            privateEvidenceRoot: input.privateEvidenceRoot,
            verdicts: [verdict],
            attestation: {
              scheme: "0g-teeml",
              providerAddress: "0xProvider",
              signingAddress: "0xSigner",
              signature: "0xsig",
              signedDigest: "0x" + "a".repeat(64),
              responseTextHash: "0x" + "b".repeat(64),
              processResponseValid: true,
              // chatSignatureLink retrieves the signed RESPONSE text (carries the secret) — a leak vector.
              chatSignatureLink: `https://provider.example/v1/proxy/signature/${SECRET}`,
              verifiedAt: "2026-06-17T10:00:00.000Z",
              verifiedBy: "vibetrace-relayer"
            }
          },
          evidenceBadges: [
            {
              claimId: "claim:claim-ai-build",
              status: "verified",
              confidence: 0.9,
              supportingNodes: ["file:src.ts"],
              // The TEE puts the secret in the badge free-text too — another leak vector.
              publicExplanation: `Supported because: ${SECRET}`,
              provenance: "structural+attested",
              verdict: "substantiated"
            }
          ]
        };
      }
    });

    // Now publish so we get the final public bundle JSON
    await runCli(["publish", "--public-summary"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined
    });

    const published = JSON.parse(await readFile(join(cwd, ".vibetrace", "published.json"), "utf8"));
    const publicBundle = await readFile(
      join(cwd, ".vibetrace", "public", `${published.publicBundleHash}.json`),
      "utf8"
    );
    const ledgerJson = await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8");

    // THE HARD CONSTRAINT: SECRET must not appear anywhere in the public bundle
    expect(publicBundle).not.toContain(SECRET);
    // The local ledger (private) also must not carry it (it was only in the adjudicator result)
    expect(ledgerJson).not.toContain(SECRET);
  });

  it("drives the upgrade gate from verifierRun.verdicts (adjudicator returns verdicts ONLY there) and recomputes badges from the gated merge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-packet-runverdicts-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      adjudicate: async (input) => {
        // The private verdicts are returned ONLY on verifierRun.verdicts (no top-level verdicts).
        // If this is silently dropped, the upgrade gate sees nothing.
        const privateVerdict: ClaimVerdict = {
          claimId: "claim:claim-ai-build",
          verdict: "substantiated",
          confidence: 0.85,
          supportingNodes: ["file:src.ts"],
          rationale: "packet shows the work",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        };
        return {
          verifierRun: {
            verifierId: "vibetrace-attested-adjudicator",
            provider: "0g-compute",
            model: "tee-model",
            requestHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            outputHash: "0x" + "3".repeat(64),
            createdAt: "2026-06-17T10:00:00.000Z",
            summary: "private-tier",
            evidenceTier: "private",
            privateEvidenceRoot: input.privateEvidenceRoot,
            verdicts: input.privatePacket ? [privateVerdict] : []
          },
          evidenceBadges: []
        };
      }
    });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    // the upgrade gate was fed verifierRun.verdicts (not silently empty).
    // the merged set is the full graph Claim baseline; claim-ai-build is upgraded (packet covers it).
    const gated = (ledger.verifier.verdicts as ClaimVerdict[]).find(
      (v) => v.claimId === "claim:claim-ai-build"
    );
    expect(gated).toBeDefined();
    expect(gated!.verdict).toBe("substantiated");
    // verifierSummary.verdicts reflects the gated merge (public-safe run carries them).
    const summaryVerdict = (ledger.verifier.verifierRun.verdicts as ClaimVerdict[]).find(
      (v) => v.claimId === "claim:claim-ai-build"
    );
    expect(summaryVerdict?.verdict).toBe("substantiated");
    // Public badges are recomputed FROM the client's graph + the gated merged verdicts (NOT the
    // empty adjudicator badges). On this no-trace repo claim-ai-build (evidence:"trace") has no
    // support edge, so the one-directional merge gate keeps it `unsupported` even though the private
    // verdict is `substantiated` — i.e. the badge is honestly recomputed, never blindly upgraded.
    const aiBuildBadge = ledger.verifier.evidenceBadges.find(
      (b: EvidenceBadge) => b.claimId === "claim:claim-ai-build"
    );
    expect(aiBuildBadge).toBeDefined();
    expect(aiBuildBadge.status).toBe("unsupported");
    expect(aiBuildBadge.provenance).toBe("structural+attested"); // recomputed WITH the verdict
  });

  it("REGRESSION: a top-level `verdicts` on the adjudicator result is IGNORED — only verifierRun.verdicts drives the gate", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-no-toplevel-verdicts-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      // An adjudicator that (incorrectly) returns verdicts ONLY at the top level. Because AdjudicateFn
      // no longer declares `verdicts`, structural typing accepts the extra field but the CLI ignores
      // it — the published verdicts must be EMPTY (verifierRun.verdicts is the single source of truth).
      adjudicate: async (input) =>
        ({
          verifierRun: {
            verifierId: "vibetrace-attested-adjudicator",
            provider: "0g-compute",
            model: "tee-model",
            requestHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            outputHash: "0x" + "3".repeat(64),
            createdAt: "2026-06-17T10:00:00.000Z",
            summary: "private-tier",
            evidenceTier: "private",
            privateEvidenceRoot: input.privateEvidenceRoot
            // NOTE: no verifierRun.verdicts here.
          },
          evidenceBadges: [],
          // Stray top-level verdicts (the old always-undefined field) — must NOT be read.
          verdicts: [
            {
              claimId: "claim:claim-ai-build",
              verdict: "substantiated",
              confidence: 0.9,
              supportingNodes: ["file:src.ts"],
              rationale: "should be ignored",
              abstainReason: null,
              dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
            }
          ]
        }) as unknown as { verifierRun: VerifierRun; evidenceBadges: EvidenceBadge[] }
    });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    // The stray top-level verdicts were ignored: no private verdicts reached the published output.
    // With no verifierRun.verdicts from the adjudicator, the merged set is the synthesized
    // all-abstain graph baseline — every claim stays unsupported (the stray top-level "substantiated"
    // never promotes anything).
    const verdicts = ledger.verifier.verdicts as ClaimVerdict[];
    expect(verdicts.every((v) => v.verdict === "unsupported")).toBe(true);
    expect(verdicts.some((v) => v.verdict === "substantiated")).toBe(false);
  });

  it("REGRESSION: structural-only-private + hostile relayer 'substantiated' for an UNCOVERED claim ends up 'unsupported'", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vibetrace-structural-only-private-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    await runCli(["init"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });
    await runCli(["snapshot"], { cwd, now: () => "2026-06-17T10:00:00.000Z", stdout: () => undefined });

    await runCli(["verify", "--private-packet", "--yes"], {
      cwd,
      now: () => "2026-06-17T10:00:00.000Z",
      stdout: () => undefined,
      // STRUCTURAL-ONLY public run: the public verifier returns a run with NO verdicts. The CLI must
      // NOT use the adjudicator's verdicts UNGATED here — trusting the raw verdict words is the hole.
      verifierFn: async () => ({
        verifierRun: {
          verifierId: "vibetrace-attested-adjudicator",
          provider: "0g-compute",
          model: "tee-model",
          requestHash: "0x" + "1".repeat(64),
          responseHash: "0x" + "2".repeat(64),
          outputHash: "0x" + "3".repeat(64),
          createdAt: "2026-06-17T10:00:00.000Z",
          summary: "structural-only",
          evidenceTier: "public-only"
          // NOTE: no verdicts — this is the structural-only path.
        },
        evidenceBadges: []
      }),
      // HOSTILE relayer: claims "substantiated" for a claim the packet carries NO evidence leaf for.
      // It cites only the metadata `claim-list` leaf (present in every packet) — which packetCoversClaim
      // must reject. With an empty public baseline synthesized for the merge, the one-directional gate
      // keeps it "unsupported".
      adjudicate: async (input) => {
        const hostile: ClaimVerdict = {
          claimId: "claim:claim-ai-build",
          verdict: "substantiated",
          confidence: 0.95,
          supportingNodes: ["claim-list"], // NOT an evidence-bearing leaf
          rationale: "trust me",
          abstainReason: null,
          dimensions: { relevance: "strong", sufficiency: "proportionate", contradiction: "none" }
        };
        return {
          verifierRun: {
            verifierId: "vibetrace-attested-adjudicator",
            provider: "0g-compute",
            model: "tee-model",
            requestHash: "0x" + "1".repeat(64),
            responseHash: "0x" + "2".repeat(64),
            outputHash: "0x" + "3".repeat(64),
            createdAt: "2026-06-17T10:00:00.000Z",
            summary: "private-tier",
            evidenceTier: "private",
            privateEvidenceRoot: input.privateEvidenceRoot,
            verdicts: [hostile]
          },
          evidenceBadges: []
        };
      }
    });

    const ledger = JSON.parse(await readFile(join(cwd, ".vibetrace", "ledger.json"), "utf8"));
    // The published verifierSummary.verdicts must NOT trust the hostile "substantiated" word.
    const published = ledger.verifier.verifierRun.verdicts.find(
      (v: ClaimVerdict) => v.claimId === "claim:claim-ai-build"
    );
    expect(published).toBeDefined();
    expect(published.verdict).toBe("unsupported");
    expect(published.abstainReason).toBe("insufficient-public-evidence");
    // Same for the top-level gated verdicts the registry/leaderboard read.
    const gated = ledger.verifier.verdicts.find(
      (v: ClaimVerdict) => v.claimId === "claim:claim-ai-build"
    );
    expect(gated.verdict).toBe("unsupported");
  });
});

describe("hosted publish: assertRelayerReceipt + publishViaRelayer", () => {
  const hx = (s: string) => "0x" + s.repeat(64).slice(0, 64);

  /** A minimal pending bundle (placeholder anchors) the CLI would POST to the relayer. */
  function pendingFixture(): PublicLedgerBundle {
    return {
      manifest: {
        schemaVersion: "vibetrace.v1",
        project: { name: "fixture" },
        repo: { root: "/fixture", commit: "c0", branch: "no-git" },
        createdAt: "2026-06-21T00:00:00.000Z",
        snapshotRoot: hx("0"),
        traceRoot: hx("0"),
        graphRoot: hx("1"),
        publicBundleHash: "pending",
        anchors: []
      },
      publicGraph: { nodes: [], edges: [], redactionPolicy: "private-by-default", canonicalHash: hx("1") },
      verifierSummary: {
        verifierId: "v", provider: "0g-dev", model: "m",
        requestHash: hx("2"), responseHash: hx("3"), outputHash: hx("4"),
        createdAt: "2026-06-21T00:00:00.000Z", summary: "s", evidenceTier: "public-only"
      },
      evidenceBadges: [],
      storageAnchor: { kind: "storage", provider: "pending", uri: "pending", rootHash: "pending", createdAt: "2026-06-21T00:00:00.000Z" },
      chainAnchor: { kind: "chain", provider: "pending", txHash: "pending", chainId: 16602, manifestHash: "pending", createdAt: "2026-06-21T00:00:00.000Z" }
    } as unknown as PublicLedgerBundle;
  }

  /** A faithful relayer receipt for `pending` — anchors + sidecar excluded from the hash, so it
   *  re-hashes to the same value. */
  function receiptFor(pending: PublicLedgerBundle) {
    const h = hashPublicLedgerBundle(pending);
    return {
      ...pending,
      manifest: { ...pending.manifest, publicBundleHash: h },
      storageAnchor: { kind: "storage", provider: "0g-storage", uri: `0g://${h}`, rootHash: hx("a"), createdAt: "2026-06-21T00:00:01.000Z" },
      chainAnchor: { kind: "chain", provider: "0g-chain", txHash: hx("b"), chainId: 16602, manifestHash: h, createdAt: "2026-06-21T00:00:01.000Z" },
      verifyAgainst0G: {
        storage: { rootHash: hx("a"), recomputedHash: h, matches: true },
        chain: { txHash: hx("b"), calldataManifestHash: h, expectedManifestHash: h, matches: true, readAt: "2026-06-21T00:00:01.000Z" }
      }
    } as unknown as PublicLedgerBundle & { verifyAgainst0G: { storage: { matches: boolean }; chain: { matches: boolean } } };
  }

  it("ACCEPTS a faithful receipt (hash + anchor + both read-backs match)", () => {
    const pending = pendingFixture();
    expect(() => assertRelayerReceipt(receiptFor(pending), pending)).not.toThrow();
  });

  it("REJECTS a substituted bundle hash (relayer altered content)", () => {
    const pending = pendingFixture();
    const tampered = receiptFor(pending);
    tampered.manifest.publicBundleHash = hx("f"); // not our content's hash
    expect(() => assertRelayerReceipt(tampered, pending)).toThrow(/does not match the content we submitted/);
  });

  it("REJECTS an anchor that commits a different hash", () => {
    const pending = pendingFixture();
    const tampered = receiptFor(pending);
    tampered.chainAnchor.manifestHash = hx("f"); // anchored something else
    expect(() => assertRelayerReceipt(tampered, pending)).toThrow(/anchor does not commit our bundle hash/);
  });

  it("REJECTS when the on-chain read-back did not match", () => {
    const pending = pendingFixture();
    const tampered = receiptFor(pending);
    tampered.verifyAgainst0G.chain.matches = false;
    expect(() => assertRelayerReceipt(tampered as any, pending)).toThrow(/on-chain read-back did not match/);
  });

  it("REJECTS when the 0G Storage object is not retrievable", () => {
    const pending = pendingFixture();
    const tampered = receiptFor(pending);
    tampered.verifyAgainst0G.storage.matches = false;
    expect(() => assertRelayerReceipt(tampered as any, pending)).toThrow(/0G Storage read-back did not match/);
  });

  it("REJECTS a swapped verifierSummary (content hash diverges)", () => {
    const pending = pendingFixture();
    const receipt = receiptFor(pending);
    (receipt.verifierSummary as { model: string }).model = "swapped-model"; // changes the hashed content
    expect(() => assertRelayerReceipt(receipt, pending)).toThrow(/does not match the content we submitted/);
  });

  it("publishViaRelayer POSTs to /publish and returns the bundle", async () => {
    const pending = pendingFixture();
    const bundle = receiptFor(pending);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bundle }) }) as any);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const got = await publishViaRelayer("https://relay.example/", "tok", pending);
      expect(got).toBe(bundle);
      const [url, init] = fetchMock.mock.calls[0] as [string, any];
      expect(url).toBe("https://relay.example/publish"); // trailing slash trimmed, /publish appended
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer tok");
      expect(JSON.parse(init.body)).toEqual({ pendingBundle: pending });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishViaRelayer throws on a non-OK relayer response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "relayer not funded" }) }) as any));
    try {
      await expect(publishViaRelayer("https://relay.example", undefined, pendingFixture())).rejects.toThrow(/Relayer publish failed \(503 relayer not funded\)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("collectFiles honors .gitignore in a git repo", () => {
  it("excludes a gitignored build dir (target/) from the snapshot, keeps real source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-git-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t"
        }
      });
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/lib.rs"), "fn main(){}\n");
      await mkdir(join(dir, "target/release"), { recursive: true });
      await writeFile(join(dir, "target/release/big.rlib"), "BINARY-ARTIFACT");
      await writeFile(join(dir, ".gitignore"), "/target\n");
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "init");

      await runCli(["init"], { cwd: dir, stdout: () => {} });
      await runCli(["snapshot"], { cwd: dir, stdout: () => {} });
      const ledger = JSON.parse(await readFile(join(dir, ".vibetrace", "ledger.json"), "utf8"));
      const files: string[] = ledger.snapshots.at(-1).files.map((f: { path: string }) => f.path);
      expect(files.some((p) => p.includes("target/"))).toBe(false);
      expect(files).toContain("src/lib.rs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("KEEPS a tracked, non-gitignored dir named like a build dir (defers to .gitignore, not the static list)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-git-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t"
        }
      });
    try {
      // "vendor" is in the static fallback list, but this repo deliberately commits source under it and
      // does NOT gitignore it — git mode must keep it.
      await mkdir(join(dir, "vendor"), { recursive: true });
      await writeFile(join(dir, "vendor/keepme.ts"), "export const x = 1;\n");
      await mkdir(join(dir, "build"), { recursive: true });
      await writeFile(join(dir, "build/tool.ts"), "export const build = true;\n");
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "init");

      await runCli(["init"], { cwd: dir, stdout: () => {} });
      await runCli(["snapshot"], { cwd: dir, stdout: () => {} });
      const ledger = JSON.parse(await readFile(join(dir, ".vibetrace", "ledger.json"), "utf8"));
      const files: string[] = ledger.snapshots.at(-1).files.map((f: { path: string }) => f.path);
      expect(files).toContain("vendor/keepme.ts");
      expect(files).toContain("build/tool.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("matchesIgnore — gitignore-style any-depth dir exclusion", () => {
  const patterns = ["node_modules/**", "dist/**", "build/**", "coverage/**", "*.log"];

  it("excludes a repo-root dependency dir", () => {
    expect(matchesIgnore("node_modules/lodash/index.js", patterns)).toBe(true);
  });

  it("excludes a NESTED node_modules (the monorepo leak that drowned coverage)", () => {
    expect(matchesIgnore("apps/web/node_modules/react/index.js", patterns)).toBe(true);
    expect(matchesIgnore("packages/x/node_modules/.bin/tsc", patterns)).toBe(true);
  });

  it("excludes nested build/dist output at any depth", () => {
    expect(matchesIgnore("packages/x/dist/out.js", patterns)).toBe(true);
    expect(matchesIgnore("apps/api/build/server.js", patterns)).toBe(true);
  });

  it("keeps real source and does NOT over-match lookalike names", () => {
    expect(matchesIgnore("src/index.ts", patterns)).toBe(false);
    expect(matchesIgnore("src/node_modules_helper.ts", patterns)).toBe(false);
    expect(matchesIgnore("lib/distance.ts", patterns)).toBe(false);
    expect(matchesIgnore("buildings/list.ts", patterns)).toBe(false);
  });
});

describe("resolveProjectName", () => {
  it("prefers a package.json name", () => {
    expect(resolveProjectName({ name: "my-pkg" }, "/home/u/some-folder")).toBe("my-pkg");
  });

  it("falls back to the folder name when package.json has no usable name", () => {
    expect(resolveProjectName({}, "/home/u/agent-arena")).toBe("agent-arena");
    expect(resolveProjectName({ name: "   " }, "/home/u/agent-arena")).toBe("agent-arena");
  });
});

describe("runCli init — project name resolution", () => {
  it("uses the folder name when package.json has none (no more 'unnamed-project')", async () => {
    const base = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    const dir = join(base, "cool-arena");
    await mkdir(dir, { recursive: true });
    try {
      await runCli(["init"], { cwd: dir, stdout: () => {} });
      const cfg = JSON.parse(await readFile(join(dir, "vibetrace.config.json"), "utf8"));
      expect(cfg.project.name).toBe("cool-arena");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("uses the package.json name when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "from-pkg" }));
      await runCli(["init"], { cwd: dir, stdout: () => {} });
      const cfg = JSON.parse(await readFile(join(dir, "vibetrace.config.json"), "utf8"));
      expect(cfg.project.name).toBe("from-pkg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the interactive prompt answer over the folder default", async () => {
    const base = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    const dir = join(base, "folder-default");
    await mkdir(dir, { recursive: true });
    try {
      await runCli(["init"], { cwd: dir, stdout: () => {}, promptText: async () => "Chosen Name" });
      const cfg = JSON.parse(await readFile(join(dir, "vibetrace.config.json"), "utf8"));
      expect(cfg.project.name).toBe("Chosen Name");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("migrates an existing LEDGER's legacy 'unnamed-project' name (what publish actually reads)", async () => {
    const base = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    const dir = join(base, "real-arena");
    await mkdir(join(dir, ".vibetrace"), { recursive: true });
    try {
      await writeFile(
        join(dir, ".vibetrace", "ledger.json"),
        JSON.stringify({
          schemaVersion: "vibetrace.local.v1",
          project: { name: "unnamed-project", root: dir },
          createdAt: new Date(0).toISOString(),
          snapshots: [],
          traces: [],
          claims: []
        })
      );
      await migrateLedgerProjectName(dir, () => {});
      const ledger = JSON.parse(await readFile(join(dir, ".vibetrace", "ledger.json"), "utf8"));
      expect(ledger.project.name).toBe("real-arena");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("leaves a deliberately-set ledger name untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    await mkdir(join(dir, ".vibetrace"), { recursive: true });
    try {
      await writeFile(
        join(dir, ".vibetrace", "ledger.json"),
        JSON.stringify({
          schemaVersion: "vibetrace.local.v1",
          project: { name: "deliberate-name", root: dir },
          createdAt: new Date(0).toISOString(),
          snapshots: [],
          traces: [],
          claims: []
        })
      );
      await migrateLedgerProjectName(dir, () => {});
      const ledger = JSON.parse(await readFile(join(dir, ".vibetrace", "ledger.json"), "utf8"));
      expect(ledger.project.name).toBe("deliberate-name");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto-heals an existing 'unnamed-project' config to the folder name", async () => {
    const base = await mkdtemp(join(tmpdir(), "vibetrace-name-"));
    const dir = join(base, "healed-arena");
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "vibetrace.config.json"),
        JSON.stringify({ schemaVersion: "vibetrace.config.v1", project: { name: "unnamed-project" } })
      );
      await runCli(["init"], { cwd: dir, stdout: () => {} });
      const ledger = JSON.parse(await readFile(join(dir, ".vibetrace", "ledger.json"), "utf8"));
      expect(ledger.project.name).toBe("healed-arena");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
