#!/usr/bin/env node
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildArtifactGraph } from "@vibetrace/graph";
import { collectClaudeCode } from "./collect.js";
import { collectCodex } from "./codex-collect.js";
import {
  assemblePrivatePacket,
  buildPublicSafeVerifierRun,
  buildPublicSafeBadges,
  renderPacketDisclosure,
  gatherFileExcerpts,
  upgradeVerdictsWithPacket,
  type PrivatePacket
} from "./private-packet.js";
import { createOgAdaptersFromEnv, type OgAdapters } from "@vibetrace/og";
import {
  ClaimInput,
  ClaimVerdict,
  CommitSnapshotData,
  EvidenceBadge,
  PublicLedgerBundle,
  TraceSpan,
  VerifierRun,
  VerifyAgainst0G,
  canonicalHash,
  canonicalStringify,
  createPublicLedgerBundle,
  hashPublicLedgerBundle,
  publicLedgerHashPayload,
  validateTraceSpans
} from "@vibetrace/schema";
import {
  buildMergedEvidenceBadges,
  runRelayerAdjudication,
  runVibeTraceVerifier,
  verifySignerAgainst0G,
  type BrokerLike
} from "@vibetrace/verifier";

const execFileAsync = promisify(execFile);
const workspaceDir = ".vibetrace";
const ledgerFile = "ledger.json";
const configFile = "vibetrace.config.json";
const requiredRealChainEnv = [
  "VIBETRACE_0G_PRIVATE_KEY",
  "VIBETRACE_0G_RPC_URL"
];
const requiredRealStorageEnv = requiredRealChainEnv;
// The attested-adjudicator leg is delegated to the hosted VibeTrace relayer
// (spec section 8): the CLI calls the relayer, which holds the funded ledger key.
// `npx vibetrace` therefore needs ONLY the relayer endpoint — never the funded
// VIBETRACE_0G_COMPUTE_PRIVATE_KEY, which lives relayer-side.
const requiredRealComputeEnv = ["VIBETRACE_RELAYER_URL"];

export type AdjudicationInput = {
  graphHash: string;
  privatePacket?: PrivatePacket;
  privateEvidenceRoot?: string;
};

export type AdjudicateFn = (input: AdjudicationInput) => Promise<{
  verifierRun: VerifierRun;
  evidenceBadges: EvidenceBadge[];
}>;

export type VerifierFn = typeof runVibeTraceVerifier;

/** Ask the user a yes/no question (true = yes). Injectable for tests; the default
 *  reads one line from an interactive TTY and returns false in non-interactive
 *  contexts (CI / piped) so `npx vibetrace` never blocks. */
export type PromptYesNo = (question: string) => Promise<boolean>;

export type CliOptions = {
  cwd?: string;
  now?: () => string;
  stdout?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  adjudicate?: AdjudicateFn;
  /** Override for testing: substitute the verifier so tests can inject public-only verdicts. */
  verifierFn?: VerifierFn;
  /** Override for testing the end-of-run "add badge to README?" prompt. */
  promptYesNo?: PromptYesNo;
};

type LocalLedger = {
  schemaVersion: "vibetrace.local.v1";
  project: {
    name: string;
    root: string;
  };
  createdAt: string;
  snapshots: CommitSnapshotData[];
  traces: TraceSpan[];
  claims: ClaimInput[];
  graph?: Awaited<ReturnType<typeof buildArtifactGraph>>;
  verifier?: Awaited<ReturnType<typeof runVibeTraceVerifier>> & { verdicts?: ClaimVerdict[] };
  published?: {
    publicBundleHash: string;
    storageUri: string;
    chainTxHash: string;
    createdAt: string;
    publicBundlePath?: string;
    viewerUrl?: string;
    verifyAgainst0G?: VerifyAgainst0G;
  };
};

type VibeTraceConfig = {
  schemaVersion: "vibetrace.config.v1";
  project: {
    name: string;
    description?: string;
  };
  privacy: {
    redaction: "private-by-default";
  };
  snapshot: {
    ignore: string[];
  };
  traces: {
    include: string[];
  };
  publish: {
    publicBundlePath?: string;
    viewerBaseUrl?: string;
    registryUrl?: string;
  };
};

const defaultRegistryUrl = "http://localhost:5173";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

type DoctorReport = {
  workspaceInitialized: boolean;
  configFound: boolean;
  packageDetected: boolean;
  gitDetected: boolean;
  snapshots: number;
  traces: number;
  graphVerified: boolean;
  published: boolean;
  mode: "dev" | "real-chain" | "real";
  missingEnv: string[];
  nextSteps: string[];
};

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? (() => new Date().toISOString());
  const stdout = options.stdout ?? ((message) => console.log(message));
  const command = argv[0];

  switch (command) {
    case "init":
      await initWorkspace(cwd, now, stdout, { ci: argv.includes("--ci") });
      return;
    case "ci":
      await runCi(cwd, argv, now, options.env ?? process.env, stdout);
      return;
    case "collect":
      await collectTraces(cwd, argv, now, stdout);
      return;
    case "ship":
      await shipFlow(cwd, argv, now, options.env ?? process.env, stdout, options.promptYesNo ?? defaultPromptYesNo);
      return;
    case "snapshot":
      await snapshotWorkspace(cwd, now, stdout);
      return;
    case "import":
      await importTrace(cwd, argv, stdout);
      return;
    case "verify": {
      // `verify <bundle.json>` re-verifies a PUBLISHED bundle file against live 0G (trustless consumer
      // path — the viewer CTA). Otherwise `verify` re-runs the LOCAL ledger graph + attested leg.
      const bundleArg = argv.slice(1).find((a) => !a.startsWith("-") && a.endsWith(".json"));
      if (bundleArg) {
        const bundlePath = isAbsolute(bundleArg) ? bundleArg : join(cwd, bundleArg);
        const ok = await reverifyPublishedBundle(bundlePath, options.env ?? process.env, stdout);
        if (!ok) process.exitCode = 1;
        return;
      }
      await verifyLedger(cwd, now, options.env ?? process.env, stdout, {
        argv,
        adjudicate: options.adjudicate,
        verifierFn: options.verifierFn
      });
      return;
    }
    case "publish":
      await publishLedger(cwd, argv, now, options.env ?? process.env, stdout);
      return;
    case "inspect":
      await inspectLedger(cwd, argv, stdout);
      return;
    case "doctor":
      await doctorWorkspace(cwd, argv, options.env ?? process.env, stdout);
      return;
    case "--help":
    case "-h":
      stdout(helpText());
      return;
    case undefined:
      // Bare `npx vibetrace` runs the one-shot ship flow.
      await shipFlow(cwd, argv, now, options.env ?? process.env, stdout, options.promptYesNo ?? defaultPromptYesNo);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function initWorkspace(
  cwd: string,
  now: () => string,
  stdout: (message: string) => void,
  options: { ci?: boolean } = {}
): Promise<void> {
  const dir = ledgerDir(cwd);
  const packageJson = await readPackageJson(cwd);
  const config = await ensureConfig(cwd, packageJson);
  await ensureGitignore(cwd);
  if (options.ci) {
    const workflowPath = await ensureCiWorkflow(cwd, await detectPackageManager(cwd));
    stdout(workflowPath ? `Created ${workflowPath}.` : "VibeTrace CI workflow already exists.");
  }

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "traces"), { recursive: true });
  await mkdir(join(dir, "public"), { recursive: true });

  if (await exists(ledgerPath(cwd))) {
    stdout("VibeTrace workspace already initialized.");
    return;
  }

  const ledger: LocalLedger = {
    schemaVersion: "vibetrace.local.v1",
    project: {
      name: config.project.name,
      root: cwd
    },
    createdAt: now(),
    snapshots: [],
    traces: [],
    claims: defaultClaims(),
  };
  await writeLedger(cwd, ledger);
  stdout("Initialized .vibetrace workspace.");
}

async function runCi(
  cwd: string,
  argv: string[],
  now: () => string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void
): Promise<void> {
  if (!(await exists(ledgerPath(cwd))) || !(await exists(configPath(cwd)))) {
    await initWorkspace(cwd, now, stdout);
  }

  await snapshotWorkspace(cwd, now, stdout);

  const config = await readConfig(cwd);
  const traceFiles = await discoverTraceFiles(cwd, config);
  let importedSpans = 0;
  for (const file of traceFiles) {
    const result = await importTraceFile(cwd, file);
    importedSpans += result.added;
    stdout(`Imported ${result.added} trace span${result.added === 1 ? "" : "s"} from ${file}.`);
  }
  if (traceFiles.length === 0) {
    stdout("No trace files discovered; continuing with a snapshot-only ledger.");
  }

  await verifyLedger(cwd, now, env, stdout);

  const publishArgs = ["publish", "--public-summary"];
  const outPath = valueAfter(argv, "--out");
  const viewerUrl = valueAfter(argv, "--viewer-url");
  if (outPath) publishArgs.push("--out", outPath);
  if (viewerUrl) publishArgs.push("--viewer-url", viewerUrl);
  await publishLedger(cwd, publishArgs, now, env, stdout);

  stdout(
    `VibeTrace CI complete: ${traceFiles.length} trace file${traceFiles.length === 1 ? "" : "s"}, ${importedSpans} imported span${importedSpans === 1 ? "" : "s"}.`
  );
}

const collectedTraceFile = "collected-trace.json";

async function collectTraces(
  cwd: string,
  argv: string[],
  now: () => string,
  stdout: (message: string) => void
): Promise<string> {
  const skipConfirm = argv.includes("--yes") || argv.includes("-y");
  const includeExcerpts = argv.includes("--include-excerpts");

  // Resolve the real repo root so symlinked/realpath'd cwds match transcript cwds.
  let repoRoot = resolve(cwd);
  try {
    repoRoot = await realpath(repoRoot);
  } catch {
    // Fall back to the resolved cwd if realpath fails.
  }

  // First pass: count matches so the disclosure is honest before we emit output.
  // Two local sources: Claude Code transcripts (~/.claude) AND Codex rollouts
  // (~/.codex). Codex edits live outside ~/.claude, so without the second source
  // the gpt-5.x work on this repo would be completely uncredited.
  const nowIso = now();
  const claudeProbe = await collectClaudeCode({ repoRoot, now: nowIso, includeExcerpts });
  const codexProbe = await collectCodex({ repoRoot, now: nowIso, includeExcerpts });
  const probe = {
    spans: [...claudeProbe.spans, ...codexProbe.spans].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId)
    ),
    sessionsScanned: claudeProbe.sessionsScanned + codexProbe.sessionsScanned,
    sessionsMatched: claudeProbe.sessionsMatched + codexProbe.sessionsMatched,
    scannedDirs: [...claudeProbe.scannedDirs, ...codexProbe.scannedDirs]
  };

  // DISCLOSURE — printed before any trace is written.
  stdout("VibeTrace collect — local AI-agent trace collection");
  stdout(`  Reading: ${probe.scannedDirs.join(", ")}`);
  stdout("  Local-only: this reads transcripts on this machine and uploads NOTHING.");
  stdout(
    `  Default output is hashes + file paths + timestamps + model — never prompt/response text${
      includeExcerpts ? " (excerpts ENABLED via --include-excerpts)" : ""
    }.`
  );
  stdout(`  Scope: only sessions whose cwd is this repo (${repoRoot}).`);
  stdout(
    `  Matched ${probe.sessionsMatched} agent run${probe.sessionsMatched === 1 ? "" : "s"} (sessions + subagents) out of ${
      probe.sessionsScanned
    } scanned.`
  );

  if (!skipConfirm) {
    stdout("  Pass --yes to confirm and write the collected trace.");
    stdout("  No files written (dry run).");
    return "";
  }

  const trace = probe.spans;
  const outPath = join(ledgerDir(cwd), collectedTraceFile);
  await mkdir(ledgerDir(cwd), { recursive: true });
  await writeFile(outPath, `${canonicalStringify(trace)}\n`, "utf8");

  const models = unique(trace.map((span) => span.model)).sort();
  const filesTraced = unique(
    trace.flatMap((span) => [...span.artifactsProduced, ...span.filesMentioned])
  ).length;

  stdout(
    `Collected ${trace.length} agent span${trace.length === 1 ? "" : "s"}, ${filesTraced} distinct file${
      filesTraced === 1 ? "" : "s"
    } traced${models.length ? ` (models: ${models.join(", ")})` : ""}.`
  );
  stdout(`Wrote ${relative(cwd, outPath).replaceAll("\\", "/")}.`);
  return outPath;
}

async function shipFlow(
  cwd: string,
  argv: string[],
  now: () => string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void,
  promptYesNo: PromptYesNo = defaultPromptYesNo
): Promise<void> {
  // Ensure workspace exists.
  if (!(await exists(ledgerPath(cwd))) || !(await exists(configPath(cwd)))) {
    await initWorkspace(cwd, now, stdout);
  }

  // 1. collect (default to --yes for the one-shot flow unless caller opted out).
  const collectArgs = ["collect", ...argv.slice(1)];
  if (!collectArgs.includes("--yes") && !collectArgs.includes("-y") && !collectArgs.includes("--no-yes")) {
    collectArgs.push("--yes");
  }
  const collectedPath = await collectTraces(cwd, collectArgs, now, stdout);

  // 2. snapshot
  await snapshotWorkspace(cwd, now, stdout);

  // 3. import the collected trace (if any spans were collected).
  if (collectedPath) {
    const relPath = relative(cwd, collectedPath).replaceAll("\\", "/");
    const result = await importTraceFile(cwd, relPath);
    stdout(`Imported ${result.added} collected span${result.added === 1 ? "" : "s"}.`);
  } else {
    stdout("No collected trace to import; continuing with a snapshot-only ledger.");
  }

  // 4. verify
  await verifyLedger(cwd, now, env, stdout);

  // 5. publish
  const publishArgs = ["publish", "--public-summary"];
  const outPath = valueAfter(argv, "--out");
  const viewerUrl = valueAfter(argv, "--viewer-url");
  if (outPath) publishArgs.push("--out", outPath);
  if (viewerUrl) publishArgs.push("--viewer-url", viewerUrl);
  await publishLedger(cwd, publishArgs, now, env, stdout);

  // 6. register — POST the published public bundle to the registry.
  const config = await readConfig(cwd);
  if (argv.includes("--no-register")) {
    stdout("Skipping registry registration (--no-register).");
    return;
  }
  const registryUrl = firstNonEmpty(
    valueAfter(argv, "--registry-url"),
    env.VIBETRACE_REGISTRY_URL,
    config.publish.registryUrl,
    defaultRegistryUrl
  )!.replace(/\/$/, "");
  // Make the upload destination visible — a repository's vibetrace config controls
  // this URL, so a malicious repo could otherwise silently exfiltrate the bundle.
  if (registryUrl !== defaultRegistryUrl) {
    stdout(`⚠ Registering with a NON-DEFAULT registry (from repo config): ${registryUrl}`);
    stdout("  Pass --no-register to skip if you did not expect this destination.");
  }
  stdout(`Registering build with ${registryUrl}/api/submit …`);
  const ledger = await readLedger(cwd);
  if (!ledger.published) {
    stdout("Publish did not record a public bundle; skipping registry registration.");
    return;
  }

  const bundlePath = join(ledgerDir(cwd), "public", `${ledger.published.publicBundleHash}.json`);
  let bundle: unknown;
  try {
    bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  } catch {
    stdout("Could not read the published public bundle; skipping registry registration.");
    return;
  }

  try {
    const response = await fetch(`${registryUrl}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      stdout(
        `Published locally, but the registry rejected the submission (HTTP ${response.status})${
          detail ? `: ${detail.slice(0, 200)}` : ""
        }.`
      );
      return;
    }
    const payload = (await response.json()) as { entry?: { id?: string; buildTier?: string } };
    const id = payload.entry?.id ?? ledger.published.publicBundleHash.replace(/^0x/, "");
    stdout(`✓ You're on the board: ${registryUrl}/#/p/${id}`);
    await offerBadge(cwd, registryUrl, id, payload.entry?.buildTier ?? "", argv, promptYesNo, stdout);
  } catch (error) {
    stdout(
      `Published locally. Registry at ${registryUrl} is unreachable (${
        error instanceof Error ? error.message : String(error)
      }); run 'vibetrace ship' again once it's up.`
    );
  }
}

/** Default end-of-run prompt: reads one y/N line from an interactive TTY. In
 *  non-interactive contexts (CI, piped input) it returns false immediately, so
 *  the one-shot never hangs waiting on stdin. */
const defaultPromptYesNo: PromptYesNo = async (question) => {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

/** After a successful publish, OFFER to drop the VibeScore badge into the README.
 *  Default behaviour ASKS (y/N); `--add-badge` adds without asking, `--no-badge`
 *  skips entirely. On decline (or non-interactive) the snippet is printed so it's
 *  one copy away. We never edit a file without an explicit yes. */
async function offerBadge(
  cwd: string,
  registryUrl: string,
  id: string,
  tier: string,
  argv: string[],
  promptYesNo: PromptYesNo,
  stdout: (message: string) => void
): Promise<void> {
  if (argv.includes("--no-badge")) return;
  const alt = tier ? `VibeScore ${tier}` : "VibeScore";
  const badgeMd = `[![${alt}](${registryUrl}/api/badge/${id}.svg)](${registryUrl}/#/p/${id})`;
  const block = `<!-- vibetrace-badge -->\n${badgeMd}\n<!-- /vibetrace-badge -->`;

  let add = argv.includes("--add-badge");
  if (!add) add = await promptYesNo("Would you like VibeTrace to add the badge to your README? (y/N)");
  if (!add) {
    stdout("Badge ready — paste it anywhere:");
    stdout(`  ${badgeMd}`);
    return;
  }
  try {
    const { path: readmePath, created } = await addBadgeToReadme(cwd, block);
    stdout(`✓ Badge ${created ? "written to new" : "added to"} ${relative(cwd, readmePath).replaceAll("\\", "/")}.`);
  } catch (error) {
    stdout(`Could not edit the README (${error instanceof Error ? error.message : String(error)}). Paste it yourself:`);
    stdout(`  ${badgeMd}`);
  }
}

/** Insert — or idempotently update — the VibeScore badge block in the repo's
 *  README. Creates README.md if none exists. HTML-comment markers let a re-run
 *  update the badge in place instead of stacking duplicates. */
export async function addBadgeToReadme(cwd: string, block: string): Promise<{ path: string; created: boolean }> {
  const START = "<!-- vibetrace-badge -->";
  const END = "<!-- /vibetrace-badge -->";
  const candidates = ["README.md", "Readme.md", "readme.md", "README.markdown", "README"];
  let readmePath: string | undefined;
  for (const name of candidates) {
    let candidate: string;
    try {
      // Symlink-safe: refuse a README that resolves through a symlink to outside
      // the project (resolveInsideProject throws on escape).
      candidate = resolveInsideProject(cwd, name);
    } catch {
      continue;
    }
    if (await exists(candidate)) {
      readmePath = candidate;
      break;
    }
  }
  if (!readmePath) {
    const created = resolveInsideProject(cwd, "README.md");
    await writeFile(created, `${block}\n`, "utf8");
    return { path: created, created: true };
  }
  let content = await readFile(readmePath, "utf8");
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start >= 0 && end > start) {
    content = content.slice(0, start) + block + content.slice(end + END.length);
  } else {
    const lines = content.split("\n");
    const h1 = lines.findIndex((line) => /^#\s/.test(line));
    if (h1 >= 0) lines.splice(h1 + 1, 0, "", block);
    else lines.unshift(block, "");
    content = lines.join("\n");
  }
  await writeFile(readmePath, content, "utf8");
  return { path: readmePath, created: false };
}

async function snapshotWorkspace(cwd: string, now: () => string, stdout: (message: string) => void): Promise<void> {
  const ledger = await readLedger(cwd);
  const config = await readConfig(cwd);
  const files = await collectFiles(cwd, config);
  const git = await readGitState(cwd, files);
  const packageMetadata = await readPackageJson(cwd);
  const snapshot: CommitSnapshotData = {
    snapshotId: `snapshot:${git.commit}:${files.length}:${now()}`,
    commit: git.commit,
    branch: git.branch,
    createdAt: now(),
    files,
    packageMetadata
  };

  ledger.snapshots.push(snapshot);
  await writeLedger(cwd, ledger);
  stdout(`Captured snapshot ${snapshot.snapshotId} with ${files.length} files.`);
}

async function importTrace(cwd: string, argv: string[], stdout: (message: string) => void): Promise<void> {
  const file = valueAfter(argv, "--file");
  if (!file) {
    throw new Error("import requires --file <trace.json>");
  }

  const result = await importTraceFile(cwd, file);
  stdout(`Imported ${result.added} trace span${result.added === 1 ? "" : "s"}.`);
}

async function importTraceFile(
  cwd: string,
  file: string
): Promise<{ added: number; skipped: number; spans: TraceSpan[] }> {
  const ledger = await readLedger(cwd);
  const input = JSON.parse(await readFile(resolveInsideProject(cwd, file), "utf8")) as unknown;
  const spans = validateTraceSpans(Array.isArray(input) ? input : (input as { spans?: unknown }).spans);
  const result = appendTraceSpans(ledger, spans);
  await mkdir(join(ledgerDir(cwd), "traces"), { recursive: true });
  await writeFile(
    join(ledgerDir(cwd), "traces", `${canonicalHash({ file, spans }).slice(2, 14)}-${spans.length}.json`),
    canonicalStringify(spans),
    "utf8"
  );
  await writeLedger(cwd, ledger);
  return {
    ...result,
    spans
  };
}

async function verifyLedger(
  cwd: string,
  now: () => string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void,
  opts: { argv?: string[]; adjudicate?: AdjudicateFn; verifierFn?: VerifierFn } = {}
): Promise<void> {
  const ledger = await readLedger(cwd);
  const graph = buildArtifactGraph({
    snapshots: ledger.snapshots,
    traces: ledger.traces,
    claims: ledger.claims
  });
  // Pass the env through so runVibeTraceVerifier can pick up VIBETRACE_RELAYER_URL and
  // delegate the JUDGMENT leg to the hosted relayer (attested by default). The CLI never
  // holds the funded key; the relayer's attestation is re-validated locally inside the
  // verifier. If no relayer is configured (or it is unreachable / unverifiable), this
  // degrades honestly to the structural-only local verifier.
  const effectiveVerifierFn = opts.verifierFn ?? runVibeTraceVerifier;
  const verifier = await effectiveVerifierFn({
    graph,
    env,
    relayerUrl: env.VIBETRACE_RELAYER_URL,
    authToken: env.VIBETRACE_RELAYER_AUTH_TOKEN,
    now
  });
  ledger.graph = graph;
  ledger.verifier = verifier;

  const argv = opts.argv ?? [];
  if (argv.includes("--private-packet")) {
    // Build a default relayer-based adjudicator when none is injected (real binary path).
    // The adjudicator receives the packet + root so it can forward them to the relayer TEE.
    const relayerUrl = env.VIBETRACE_RELAYER_URL;
    const effectiveAdjudicate: AdjudicateFn | undefined =
      opts.adjudicate ??
      (relayerUrl
        ? async (input) =>
            runRelayerAdjudication({
              graph,
              relayerUrl,
              authToken: env.VIBETRACE_RELAYER_AUTH_TOKEN,
              evidenceTier: input.privatePacket ? "private" : "public-only",
              privateEvidenceRoot: input.privateEvidenceRoot,
              privatePacket: input.privatePacket
            })
        : undefined);

    if (!effectiveAdjudicate) {
      // No adjudicator and no relayer URL configured — skip the private packet path.
      await writeLedger(cwd, ledger);
      stdout(`Verified ledger graph ${graph.canonicalHash}.`);
      return;
    }

    const ok = await runPrivatePacketAdjudication(cwd, ledger, graph, argv, now, env, stdout, effectiveAdjudicate);
    if (!ok) {
      // Dry run: disclosure printed, nothing sent. Persist the public-only run unchanged.
      await writeLedger(cwd, ledger);
      stdout(`Verified ledger graph ${graph.canonicalHash}.`);
      return;
    }
  }

  await writeLedger(cwd, ledger);
  stdout(`Verified ledger graph ${graph.canonicalHash}.`);
}

async function runPrivatePacketAdjudication(
  cwd: string,
  ledger: LocalLedger,
  graph: NonNullable<LocalLedger["graph"]>,
  argv: string[],
  now: () => string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void,
  adjudicate: AdjudicateFn
): Promise<boolean> {
  const snapshot = ledger.snapshots.at(-1);
  if (!snapshot) {
    stdout("No snapshot to build a private packet from; run vibetrace snapshot first.");
    return false;
  }

  const redact = collectFlagValues(argv, "--redact");
  const candidatePaths = snapshot.files.map((f) => f.path).slice(0, 50);
  const excerpts = await gatherFileExcerpts(candidatePaths, async (rel) => {
    try {
      return await readFile(resolveInsideProject(cwd, rel), "utf8");
    } catch {
      return undefined;
    }
  });
  const claimIds = ledger.claims.map((c) => `claim:${c.claimId}`).sort();

  const packet = assemblePrivatePacket({
    publicBundleHash: graph.canonicalHash,
    snapshotHash: canonicalHash(snapshot),
    claimIds,
    fileExcerpts: excerpts,
    redact,
    sealedTransportConfirmed: env.VIBETRACE_0G_SEALED_TRANSPORT === "confirmed"
  });

  for (const line of renderPacketDisclosure(packet)) stdout(line);

  if (!argv.includes("--yes") && !argv.includes("-y")) {
    stdout("  Pass --yes to confirm and send this packet to the examiner.");
    stdout("  No packet sent (dry run).");
    return false;
  }

  // Read verdicts from verifierRun.verdicts (where runVibeTraceVerifier stores them),
  // not from the top-level ledger.verifier.verdicts (which is only written after the
  // private run completes).
  const publicVerdicts = ledger.verifier?.verifierRun?.verdicts ?? [];
  const result = await adjudicate({
    graphHash: graph.canonicalHash,
    privatePacket: packet,
    privateEvidenceRoot: packet.evidenceRoot
  });

  // The adjudicator returns its verdicts on verifierRun.verdicts (both adjudicator
  // impls do); a `result.verdicts` read would always be undefined, so the upgrade gate would
  // see an empty private set and silently drop every private verdict.
  const adjVerdicts = result.verifierRun?.verdicts ?? [];
  // Private structural-only honesty: when the public-only run produced no verdicts
  // (structural-only path), we MUST NOT trust the adjudicator's verdict words ungated — a hostile
  // relayer could inject "substantiated" for a claim the packet carries no evidence for. Instead,
  // synthesize an all-abstain public baseline from the graph's real Claim nodes, then ALWAYS run the
  // one-directional packet-coverage gate. The gate only promotes a claim that (a) abstained for
  // insufficient public evidence, (b) the private run substantiated, AND (c) the packet actually
  // covers with an evidence-bearing leaf (packetCoversClaim).
  const publicBaseline: ClaimVerdict[] = publicVerdicts.length
    ? publicVerdicts
    : graph.nodes
        .filter((n) => n.type === "Claim")
        .map((n): ClaimVerdict => ({
          claimId: n.id,
          verdict: "unsupported",
          confidence: 0,
          supportingNodes: [],
          rationale: "Insufficient public evidence.",
          abstainReason: "insufficient-public-evidence",
          dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
        }));
  const rawMergedVerdicts = upgradeVerdictsWithPacket(publicBaseline, adjVerdicts, packet);

  // Scrub rationale from every verdict before persisting.
  // A private-tier adjudicator may embed private-evidence text in rationale fields;
  // those must never appear in the local ledger (which is later serialized into the
  // public bundle's verifierSummary). Public-only verdicts that were NOT upgraded by
  // the private run retain their original rationale (from the public verifier).
  const privateById = new Set(adjVerdicts.map((v) => v.claimId));
  const mergedVerdicts = rawMergedVerdicts.map((v) =>
    privateById.has(v.claimId)
      ? { ...v, rationale: "Rationale withheld — derived from private evidence." }
      : v
  );

  // Build a PUBLIC-SAFE verifierRun; never persist the raw adjudicator result
  // (it may carry private-evidence-derived rationale or summary text that would leak
  // into the public bundle's verifierSummary field at publish time).
  // Allowed public Claim ids — the publish boundary drops any verdict/badge whose claimId is not a real
  // public Claim (defense-in-depth: never trust the relayer's claimIds).
  const allowedClaimIds = new Set(graph.nodes.filter((n) => n.type === "Claim").map((n) => n.id));
  ledger.verifier = {
    verifierRun: buildPublicSafeVerifierRun(
      { ...result.verifierRun, verdicts: mergedVerdicts }, // gated verdicts drive verifierSummary.verdicts
      { privateEvidenceRoot: packet.evidenceRoot, allowedClaimIds }
    ),
    // Public badges MUST reflect the packet-GATED merged verdicts, not the raw adjudicator badges:
    // recompute them locally from the client's graph + the gated verdicts (and scrub free-text).
    evidenceBadges: buildPublicSafeBadges(buildMergedEvidenceBadges(graph, mergedVerdicts), allowedClaimIds),
    verdicts: mergedVerdicts
  };
  stdout(`Private packet sent (${packet.leaves.length} leaves, root ${packet.evidenceRoot}).`);
  return true;
}

/** Collect every value following each occurrence of a repeatable flag. */
function collectFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && typeof argv[i + 1] === "string") values.push(argv[i + 1]);
  }
  return values;
}

/**
 * Build a READ-ONLY 0G Compute broker for the signer re-verification leg. Reads (listServiceWithDetail,
 * verifyService) need a wallet to instantiate the SDK but NO funds, so a consumer with only the RPC can
 * re-verify. Gated + fail-closed: returns null when the compute env is absent or the SDK/wallet cannot be
 * built (the signer leg is then simply OMITTED — never faked). Dynamic-import keeps the heavy compute SDK
 * out of the default `npx vibetrace` path (only loaded in real-compute mode), mirroring the storage adapter.
 */
async function createReadOnlyComputeBroker(env: NodeJS.ProcessEnv): Promise<BrokerLike | null> {
  const rpcUrl = env.VIBETRACE_0G_COMPUTE_RPC_URL ?? env.VIBETRACE_0G_RPC_URL;
  if (!rpcUrl) return null;
  try {
    const [{ createZGComputeNetworkBroker }, { ethers }] = await Promise.all([
      import("@0gfoundation/0g-compute-ts-sdk") as Promise<any>,
      import("ethers") as Promise<any>
    ]);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // A wallet is required to construct the broker; reads do not spend. Use the operator key when present
    // (produce time), else a deterministic throwaway (pure consumer re-verify needs no funds).
    const key = env.VIBETRACE_0G_COMPUTE_PRIVATE_KEY ?? env.VIBETRACE_0G_PRIVATE_KEY ?? ("0x" + "1".repeat(64));
    const wallet = new ethers.Wallet(key, provider);
    return (await createZGComputeNetworkBroker(wallet)) as BrokerLike;
  } catch {
    return null; // fail-closed: no broker → no signer leg (honest omission)
  }
}

export async function verifyBundleAgainst0G(
  adapters: OgAdapters,
  input: {
    storageRootHash: string;
    expectedStorageHash: string;
    chainTxHash: string;
    expectedManifestHash: string;
    /** The bundle's recorded 0G chain id; passed to readManifest so a wrong/malicious
     *  RPC cannot spoof the chain leg of "verify against live 0G". */
    expectedChainId?: number;
    readAt: string;
    /** When supplied (real-compute bundles), re-verify the attestation's signer against live 0G. */
    signer?: { broker: BrokerLike; providerAddress: string; expectedSigner: string };
  }
): Promise<VerifyAgainst0G> {
  const fetched = await adapters.storage.downloadJson(input.storageRootHash);
  const recomputedHash = canonicalHash(fetched);
  const calldataManifestHash = await adapters.chain.readManifest(input.chainTxHash, input.expectedChainId);
  const result: VerifyAgainst0G = {
    storage: {
      rootHash: input.storageRootHash,
      recomputedHash,
      matches: recomputedHash === input.expectedStorageHash
    },
    chain: {
      txHash: input.chainTxHash,
      calldataManifestHash,
      expectedManifestHash: input.expectedManifestHash,
      matches: calldataManifestHash === input.expectedManifestHash,
      readAt: input.readAt
    }
  };
  // Optional consumer-verifiable signer leg (verifySignerAgainst0G is fail-closed — never throws).
  if (input.signer) {
    result.signer = await verifySignerAgainst0G(input.signer.broker, {
      providerAddress: input.signer.providerAddress,
      expectedSigner: input.signer.expectedSigner
    });
  }
  return result;
}

/**
 * Trustless CONSUMER re-verification of a PUBLISHED bundle file against live 0G — the command the viewer
 * CTA points at (`npx vibetrace verify <bundle.json>`). Re-fetches the 0G Storage object and re-hashes it,
 * re-reads the chain calldata, and re-checks the attestation's signer against the provider's on-chain
 * acknowledged + quote-verified TEE signer. Reads need NO funded key (downloads/reads only), so anyone can
 * run it. Returns true iff every applicable leg matches. Dev-anchor bundles have no live object — reported
 * honestly, not failed.
 */
export async function reverifyPublishedBundle(
  bundlePath: string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void,
  deps: { adapters?: OgAdapters; broker?: BrokerLike | null } = {}
): Promise<boolean> {
  const raw = await readFile(bundlePath, "utf8");
  const bundle = JSON.parse(raw) as PublicLedgerBundle & {
    storageAnchor?: { provider?: string; rootHash?: string };
    chainAnchor?: { txHash?: string; chainId?: number };
    manifest?: { publicBundleHash?: string };
    verifierSummary?: VerifierRun;
  };

  const storageProvider = String(bundle.storageAnchor?.provider ?? "");
  if (storageProvider !== "0g-storage") {
    stdout(
      `This is a ${storageProvider || "dev"}-anchor bundle (no live 0G Storage object), so there is nothing to ` +
        `re-fetch from the indexer. Bundle re-hash + signature recovery still apply offline.`
    );
    return true;
  }

  // Force real read adapters regardless of the local VIBETRACE_OG_MODE — the bundle's anchors ARE real, and
  // downloads/reads need only the public indexer + RPC (no key). Injectable for tests.
  const adapters =
    deps.adapters ?? createOgAdaptersFromEnv({ workspace: "/tmp/vt-reverify", env: { ...env, VIBETRACE_OG_MODE: "real" } });

  // The downloaded object must re-hash to the bundle's CONTENT hash (publicLedgerHashPayload strips the
  // sidecar, reproducing exactly what was uploaded). NOT the storage rootHash (a Merkle root for real 0G).
  const expectedStorageHash = canonicalHash(publicLedgerHashPayload(bundle));

  const att = bundle.verifierSummary?.attestation;
  let signerInput: { broker: BrokerLike; providerAddress: string; expectedSigner: string } | undefined;
  if (att?.providerAddress && att?.signingAddress) {
    const broker = deps.broker !== undefined ? deps.broker : await createReadOnlyComputeBroker(env);
    if (broker) signerInput = { broker, providerAddress: att.providerAddress, expectedSigner: att.signingAddress };
  }

  let v: VerifyAgainst0G;
  try {
    v = await verifyBundleAgainst0G(adapters, {
      storageRootHash: String(bundle.storageAnchor?.rootHash ?? ""),
      expectedStorageHash,
      chainTxHash: String(bundle.chainAnchor?.txHash ?? ""),
      expectedManifestHash: String(bundle.manifest?.publicBundleHash ?? ""),
      expectedChainId: bundle.chainAnchor?.chainId != null ? Number(bundle.chainAnchor.chainId) : undefined,
      readAt: new Date().toISOString(),
      signer: signerInput
    });
  } catch (error) {
    stdout(`✗ Re-verification could not reach live 0G: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  stdout(`${mark(v.storage.matches)} 0G STORAGE  downloaded object re-hashes to the bundle content hash`);
  stdout(`${mark(v.chain.matches)} 0G CHAIN    tx calldata == bundle manifest hash`);
  if (v.signer) {
    const quoteNote = v.signer.quoteVerified ? "; live quote re-verified" : "; live quote not re-checked";
    stdout(
      `${mark(v.signer.matches)} 0G SIGNER   attestation signer ${v.signer.matches ? "IS" : "is NOT"} the provider's ` +
        `on-chain-acknowledged TEE signer (on-chain: ${v.signer.onChainSigner ?? "—"}${quoteNote})`
    );
  } else if (att) {
    stdout(`· 0G SIGNER   skipped (no compute RPC configured for the signer re-check)`);
  }
  const allOk = v.storage.matches && v.chain.matches && (v.signer ? v.signer.matches : true);
  stdout(allOk ? "RESULT: PASS — every live-0G leg matches." : "RESULT: FAIL — at least one leg does not match.");
  return allOk;
}

/**
 * Anchor + store a pending bundle and attach the live-0G read-back sidecar — i.e. the FUNDED
 * 0G writes (storage upload + chain anchor). Shared by the offline CLI publish path (dev/local
 * adapters, no key) AND the hosted relayer's /publish endpoint (relayer-funded real adapters), so
 * a user never needs their own key. SECURITY: the bundle hash is RECOMPUTED here from the pending
 * bundle (never trusted from a caller), so the anchored calldata always equals the hash of the
 * content actually uploaded — a caller cannot make the relayer anchor a hash unrelated to its bytes.
 */
export async function anchorStoreAndVerify(
  adapters: OgAdapters,
  pendingBundle: PublicLedgerBundle,
  opts: { broker?: BrokerLike | null; now: () => string }
): Promise<PublicLedgerBundle & { verifyAgainst0G: VerifyAgainst0G }> {
  const bundleHash = hashPublicLedgerBundle(pendingBundle);
  const contentForStorage = publicLedgerHashPayload({
    ...pendingBundle,
    manifest: { ...pendingBundle.manifest, publicBundleHash: bundleHash }
  });
  const storageAnchor = await adapters.storage.uploadJson(contentForStorage);
  const chainAnchor = await adapters.chain.anchorManifest(bundleHash);
  const bundle = createPublicLedgerBundle({
    ...pendingBundle,
    storageAnchor,
    chainAnchor,
    manifest: { ...pendingBundle.manifest, anchors: [storageAnchor, chainAnchor] }
  });
  // When the run carries a real TEE attestation, re-verify its signer against live 0G (read-only
  // broker, supplied by the caller). Fail-closed: no broker ⇒ signer leg omitted, never faked.
  const att = pendingBundle.verifierSummary.attestation;
  const signerInput =
    att?.providerAddress && att?.signingAddress && opts.broker
      ? { broker: opts.broker, providerAddress: att.providerAddress, expectedSigner: att.signingAddress }
      : undefined;
  const verifyAgainst0G = await verifyBundleAgainst0G(adapters, {
    storageRootHash: storageAnchor.rootHash,
    // Re-hash the DOWNLOADED object and compare to the CONTENT hash — NOT the storage rootHash
    // (a Merkle root for real 0G ≠ sha256 of the content).
    expectedStorageHash: canonicalHash(contentForStorage),
    chainTxHash: chainAnchor.txHash,
    expectedManifestHash: bundleHash,
    expectedChainId: chainAnchor.chainId,
    readAt: opts.now(),
    signer: signerInput
  });
  return { ...bundle, verifyAgainst0G };
}

/**
 * Delegate the FUNDED 0G writes to the hosted VibeTrace relayer (POST /publish). The relayer anchors
 * + uploads with ITS key and returns the finished bundle — so a user running `npx vibetrace` never
 * needs a private key or gas. The caller MUST re-verify the receipt (assertRelayerReceipt) before
 * trusting or persisting it.
 */
export async function publishViaRelayer(
  relayerUrl: string,
  authToken: string | undefined,
  pendingBundle: PublicLedgerBundle
): Promise<PublicLedgerBundle & { verifyAgainst0G: VerifyAgainst0G }> {
  const url = `${relayerUrl.replace(/\/+$/, "")}/publish`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    body: JSON.stringify({ pendingBundle })
  });
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) detail = `${res.status} ${b.error}`;
    } catch {
      /* keep the status-only detail */
    }
    throw new Error(`Relayer publish failed (${detail}). The hosted relayer funds 0G anchoring; check VIBETRACE_RELAYER_URL or retry.`);
  }
  const body = (await res.json()) as { bundle?: PublicLedgerBundle & { verifyAgainst0G: VerifyAgainst0G } };
  if (!body?.bundle) throw new Error("Relayer publish returned no bundle.");
  return body.bundle;
}

/**
 * Re-verify a relayer-built receipt against the bundle WE submitted, so a malicious or buggy relayer
 * cannot substitute content. Anchors + the sidecar are EXCLUDED from the bundle hash, so our
 * placeholder-anchor `pendingBundle` and the returned real-anchor bundle MUST hash identically iff the
 * content (graph, verifierSummary, badges, manifest meta) is unchanged. We require: the returned hash
 * equals our pending bundle's hash, the bundle re-hashes to that value, the chain anchor commits it,
 * and the on-chain read-back matched. Fail-closed — throws on any divergence.
 */
export function assertRelayerReceipt(
  bundle: PublicLedgerBundle & { verifyAgainst0G?: VerifyAgainst0G },
  pendingBundle: PublicLedgerBundle
): void {
  const expectedHash = hashPublicLedgerBundle(pendingBundle);
  if (bundle.manifest.publicBundleHash !== expectedHash) {
    throw new Error("Relayer receipt rejected: the returned bundle does not match the content we submitted (hash differs).");
  }
  if (hashPublicLedgerBundle(bundle) !== expectedHash) {
    throw new Error("Relayer receipt rejected: the returned bundle is internally inconsistent (re-hash mismatch).");
  }
  if (bundle.chainAnchor?.manifestHash !== expectedHash) {
    throw new Error("Relayer receipt rejected: the on-chain anchor does not commit our bundle hash.");
  }
  if (!bundle.verifyAgainst0G?.chain?.matches) {
    throw new Error("Relayer receipt rejected: the on-chain read-back did not match the bundle hash.");
  }
  if (!bundle.verifyAgainst0G?.storage?.matches) {
    throw new Error("Relayer receipt rejected: the 0G Storage read-back did not match (object not retrievable).");
  }
}

async function publishLedger(
  cwd: string,
  argv: string[],
  now: () => string,
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void
): Promise<void> {
  if (!argv.includes("--public-summary")) {
    throw new Error("publish requires explicit --public-summary to opt in to public output.");
  }

  const ledger = await readLedger(cwd);
  const config = await readConfig(cwd);
  if (!ledger.graph || !ledger.verifier) {
    await verifyLedger(cwd, now, env, () => undefined);
  }
  const verifiedLedger = await readLedger(cwd);
  if (!verifiedLedger.graph || !verifiedLedger.verifier) {
    throw new Error("Unable to publish because verification did not produce a graph.");
  }

  const adapters = createOgAdaptersFromEnv({
    workspace: ledgerDir(cwd),
    now,
    env
  });

  const placeholderStorage = {
    kind: "storage" as const,
    provider: "pending",
    uri: "pending",
    rootHash: "pending",
    createdAt: now()
  };
  const placeholderChain = {
    kind: "chain" as const,
    provider: "pending",
    txHash: "pending",
    chainId: Number(env.VIBETRACE_0G_CHAIN_ID ?? "16602"),
    manifestHash: "pending",
    createdAt: now()
  };
  const latestSnapshot = verifiedLedger.snapshots.at(-1);
  // By DEFAULT the funded 0G writes are delegated to the hosted relayer (it anchors + uploads with its
  // own key, so the user needs none). The hosted relayer always uses REAL 0G Storage; a local "real"
  // mode does too. Either path yields a real 0G Storage object, so the storage badge reflects that —
  // and we still block promoting it to "verified" when the verdict is unsupported. Badges are
  // hashed INTO the bundle, so this must be decided here, before the relayer anchors it unchanged.
  const relayerUrl = env.VIBETRACE_RELAYER_URL;
  const usesRealStorage = Boolean(relayerUrl) || env.VIBETRACE_OG_MODE === "real";
  const evidenceBadges = augmentEvidenceBadgesForPublish(verifiedLedger.verifier.evidenceBadges, {
    storageProvider: usesRealStorage ? "0g-storage" : undefined,
    verifierProvider: verifiedLedger.verifier.verifierRun.provider,
    verifierModel: verifiedLedger.verifier.verifierRun.model,
    // Only promote the compute/TEE badges when the run carries a structurally valid
    // (honestly-labeled `attests: "tee-execution"`) attestation — never from the provider string alone.
    attested: hasValidatedAttestationShape(verifiedLedger.verifier.verifierRun)
  });
  const manifest = {
    schemaVersion: "vibetrace.v1" as const,
    project: {
      name: verifiedLedger.project.name
    },
    repo: {
      root: verifiedLedger.project.root,
      commit: latestSnapshot?.commit ?? "unknown",
      branch: latestSnapshot?.branch
    },
    createdAt: now(),
    snapshotRoot: canonicalHash(verifiedLedger.snapshots),
    traceRoot: canonicalHash(verifiedLedger.traces.map(stripTraceExcerpts)),
    graphRoot: verifiedLedger.graph.canonicalHash,
    publicBundleHash: "pending",
    anchors: []
  };
  const pendingBundle: PublicLedgerBundle = {
    manifest,
    publicGraph: verifiedLedger.graph,
    verifierSummary: verifiedLedger.verifier.verifierRun,
    evidenceBadges,
    storageAnchor: placeholderStorage,
    chainAnchor: placeholderChain
  };
  // FUNDED 0G writes (storage upload + chain anchor + read-back). DEFAULT: delegate to the hosted
  // VibeTrace relayer (POST /publish), which funds them with ITS key — so `npx vibetrace` needs no
  // private key or gas. With NO relayer configured, fall back to the LOCAL adapters (dev = free +
  // keyless; or a self-hosted real run with your own key). The receipt is re-verified before we trust it.
  let bundleWithSidecar: PublicLedgerBundle & { verifyAgainst0G: VerifyAgainst0G };
  if (relayerUrl) {
    bundleWithSidecar = await publishViaRelayer(relayerUrl, env.VIBETRACE_RELAYER_AUTH_TOKEN, pendingBundle);
    assertRelayerReceipt(bundleWithSidecar, pendingBundle);
  } else {
    const att = verifiedLedger.verifier.verifierRun.attestation;
    const signerBroker = att?.providerAddress && att?.signingAddress ? await createReadOnlyComputeBroker(env) : null;
    bundleWithSidecar = await anchorStoreAndVerify(adapters, pendingBundle, { broker: signerBroker, now });
  }
  const bundle = bundleWithSidecar;
  const { storageAnchor, chainAnchor, verifyAgainst0G } = bundleWithSidecar;

  await mkdir(join(ledgerDir(cwd), "public"), { recursive: true });
  const publicBundleJson = `${canonicalStringify(bundleWithSidecar)}\n`;
  await writeFile(join(ledgerDir(cwd), "public", `${bundleWithSidecar.manifest.publicBundleHash}.json`), publicBundleJson, "utf8");

  const publicBundlePath = valueAfter(argv, "--out") ?? config.publish.publicBundlePath;
  if (publicBundlePath) {
    const outPath = resolveInsideProject(cwd, publicBundlePath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, publicBundleJson, "utf8");
  }

  const viewerBaseUrl = firstNonEmpty(valueAfter(argv, "--viewer-url"), env.VIBETRACE_VIEWER_URL, config.publish.viewerBaseUrl);
  const viewerUrl = viewerBaseUrl ? buildViewerUrl(viewerBaseUrl, bundleWithSidecar.manifest.publicBundleHash) : undefined;

  verifiedLedger.published = {
    publicBundleHash: bundle.manifest.publicBundleHash,
    storageUri: storageAnchor.uri,
    chainTxHash: chainAnchor.txHash,
    createdAt: now(),
    publicBundlePath,
    viewerUrl,
    verifyAgainst0G
  };
  await writeLedger(cwd, verifiedLedger);
  await writeFile(join(ledgerDir(cwd), "published.json"), canonicalStringify(verifiedLedger.published), "utf8");
  await writeFile(
    join(ledgerDir(cwd), "verify-against-0g.json"),
    canonicalStringify(verifyAgainst0G),
    "utf8"
  );
  stdout(`Published public ledger ${bundle.manifest.publicBundleHash}.`);
  stdout(
    `Verified against 0G: storage ${verifyAgainst0G.storage.matches ? "matches" : "MISMATCH"}, ` +
      `chain ${verifyAgainst0G.chain.matches ? "matches" : "MISMATCH"}` +
      `${verifyAgainst0G.signer ? `, signer ${verifyAgainst0G.signer.matches ? "matches" : "MISMATCH"}` : ""}.`
  );
  if (publicBundlePath) {
    stdout(`Exported public bundle ${publicBundlePath}.`);
  }
  if (viewerUrl) {
    stdout(`Viewer URL: ${viewerUrl}`);
  }
}

/**
 * True iff the run carries a STRUCTURALLY VALID 0G TeeML attestation — the gate for promoting the
 * 0G-compute / TEE badges. It requires the honest `attests: "tee-execution"` marker plus the crypto
 * fields needed to re-derive the TEE-execution proof (scheme, signer, signature, digest, hashes) and
 * `processResponseValid`. This is a SHAPE check (does the bundle claim a real attestation?), not a
 * re-verification of the signature — the client already re-derived the proof in runRelayerAdjudication.
 * A run missing `attests` (legacy data) returns false → no compute/TEE upgrade.
 */
export function hasValidatedAttestationShape(run: VerifierRun): boolean {
  const a = run.attestation;
  return (
    !!a &&
    a.scheme === "0g-teeml" &&
    a.attests === "tee-execution" &&
    a.processResponseValid === true &&
    typeof a.signature === "string" && a.signature.length > 0 &&
    typeof a.signedDigest === "string" && a.signedDigest.length > 0 &&
    typeof a.responseTextHash === "string" && a.responseTextHash.length > 0 &&
    typeof a.signingAddress === "string" && a.signingAddress.length > 0
  );
}

export function augmentEvidenceBadgesForPublish(
  badges: EvidenceBadge[],
  options: { storageProvider?: string; verifierProvider: string; verifierModel: string; attested?: boolean }
): EvidenceBadge[] {
  // Apply a live-0G "provider evidence" upgrade to a 0G-claim badge — but NEVER let the
  // structural fact ("the artifact exists on 0G") override the attested examiner's own
  // verdict. When that verdict is unsupported/inflated we still RECORD the provider
  // evidence (as a supporting node + honest explanation) but do NOT promote the badge to
  // "verified", so the badge status can never contradict the verdict (honesty: the badge
  // attests the artifact exists on 0G; the verdict is what the examiner concluded).
  const applyOgEvidence = (badge: EvidenceBadge, evidenceNode: string, verifiedExplanation: string): EvidenceBadge => {
    const supportingNodes = [...new Set([...badge.supportingNodes, evidenceNode])].sort();
    if (badge.verdict === "unsupported" || badge.verdict === "inflated") {
      return {
        ...badge,
        supportingNodes,
        publicExplanation: `Live 0G evidence recorded (${evidenceNode}), but the attested examiner did not substantiate this claim from public evidence (verdict: ${badge.verdict}).`
      };
    }
    return {
      ...badge,
      status: "verified",
      confidence: Math.max(badge.confidence, 0.95),
      supportingNodes,
      publicExplanation: verifiedExplanation
    };
  };

  return badges.map((badge) => {
    if (badge.claimId === "claim:claim-0g-storage" && options.storageProvider === "0g-storage") {
      return applyOgEvidence(
        badge,
        "anchor:storage:0g-storage",
        "The public bundle was uploaded to 0G Storage and records a 0G Storage root hash."
      );
    }

    if (badge.claimId === "claim:claim-0g-compute" && options.verifierProvider === "0g-compute" && options.attested === true) {
      return applyOgEvidence(
        badge,
        `verifier:${options.verifierProvider}:${options.verifierModel}`,
        "The build was examined by an inference running in an attested 0G Compute (TeeML) enclave (execution and response-hash signed by the provider's 0G TEE signer named by the attestation; the signature recovers to that signer); verdict content is relayed by the operator."
      );
    }

    if (badge.claimId === "claim:claim-tee-attested" && options.verifierProvider === "0g-compute" && options.attested === true) {
      return applyOgEvidence(
        badge,
        `attestation:0g-teeml:${options.verifierModel}`,
        "Independently examined by an inference running in an attested 0G TEE enclave — execution and response-hash signed by the provider's 0G TEE signer named by the attestation; verdict content relayed by the operator (re-verify the signature recovers to that signer; VibeTrace does not check the signer against the provider's on-chain registry)."
      );
    }

    return badge;
  });
}

async function inspectLedger(cwd: string, argv: string[], stdout: (message: string) => void): Promise<void> {
  const ledger = await readLedger(cwd);
  const summary = {
    project: ledger.project.name,
    snapshots: ledger.snapshots.length,
    traceSpans: ledger.traces.length,
    claims: ledger.claims.length,
    graph: ledger.graph?.canonicalHash ?? null,
    published: ledger.published ?? null
  };

  if (argv.includes("--json")) {
    stdout(JSON.stringify(summary, null, 2));
    return;
  }

  stdout(
    [
      `Project: ${summary.project}`,
      `Snapshots: ${summary.snapshots}`,
      `Trace spans: ${summary.traceSpans}`,
      `Claims: ${summary.claims}`,
      `Graph: ${summary.graph ?? "not verified"}`,
      `Published: ${summary.published?.publicBundleHash ?? "no"}`
    ].join("\n")
  );
}

async function doctorWorkspace(
  cwd: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdout: (message: string) => void
): Promise<void> {
  const report = await createDoctorReport(cwd, env);
  if (argv.includes("--json")) {
    stdout(JSON.stringify(report, null, 2));
    return;
  }

  stdout(
    [
      "VibeTrace doctor",
      `Workspace: ${report.workspaceInitialized ? "initialized" : "missing"}`,
      `Config: ${report.configFound ? "found" : "missing"}`,
      `Package: ${report.packageDetected ? "detected" : "missing"}`,
      `Git: ${report.gitDetected ? "detected" : "not detected"}`,
      `Snapshots: ${report.snapshots}`,
      `Trace spans: ${report.traces}`,
      `Graph: ${report.graphVerified ? "verified" : "not verified"}`,
      `Published: ${report.published ? "yes" : "no"}`,
      `0G mode: ${report.mode}`,
      report.missingEnv.length ? `Missing env: ${report.missingEnv.join(", ")}` : "Missing env: none",
      report.nextSteps.length ? `Next steps:\n- ${report.nextSteps.join("\n- ")}` : "Next steps: none"
    ].join("\n")
  );
}

async function createDoctorReport(cwd: string, env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const packageJson = await readPackageJson(cwd);
  const workspaceInitialized = await exists(ledgerPath(cwd));
  const configFound = await exists(configPath(cwd));
  const ledger = workspaceInitialized ? await readLedger(cwd) : undefined;
  const mode = ogMode(env);
  // With a hosted relayer configured, the FUNDED 0G writes (anchor + storage + compute) all happen
  // relayer-side, so the CLI needs ONLY the relayer endpoint — never a client funded key. Without a
  // relayer, a real / real-chain run is SELF-HOSTED and must carry the client's own funded key.
  const hosted = Boolean(env.VIBETRACE_RELAYER_URL);
  const requiredEnv = hosted
    ? requiredRealComputeEnv
    : mode === "real"
      ? requiredRealStorageEnv
      : mode === "real-chain"
        ? requiredRealChainEnv
        : [];
  const missingEnv = requiredEnv.filter((name) => !env[name]);
  const nextSteps: string[] = [];

  if (!workspaceInitialized) {
    nextSteps.push("Run vibetrace init to create a private local ledger.");
  }
  if (!configFound) {
    nextSteps.push("Run vibetrace init to create vibetrace.config.json.");
  }
  if (!ledger?.snapshots.length) {
    nextSteps.push("Run vibetrace ci to record, verify, and publish the current build story.");
  }
  if (!ledger?.traces.length) {
    nextSteps.push("Drop trace JSON into .agenttrace/, traces/, ai-traces/, or .vibetrace/inbox/.");
  }
  if (!ledger?.graph) {
    nextSteps.push("Run vibetrace ci to build artifact lineage and evidence badges.");
  }
  if (!ledger?.published) {
    nextSteps.push("Run vibetrace ci to create a redacted public bundle.");
  }
  if (missingEnv.length) {
    nextSteps.push("Set the missing live 0G environment variables or use dev mode for local publishing.");
  }

  return {
    workspaceInitialized,
    configFound,
    packageDetected: Object.keys(packageJson).length > 0,
    gitDetected: await hasGit(cwd),
    snapshots: ledger?.snapshots.length ?? 0,
    traces: ledger?.traces.length ?? 0,
    graphVerified: Boolean(ledger?.graph),
    published: Boolean(ledger?.published),
    mode,
    missingEnv,
    nextSteps
  };
}

function ogMode(env: NodeJS.ProcessEnv): DoctorReport["mode"] {
  return env.VIBETRACE_OG_MODE === "real"
    ? "real"
    : env.VIBETRACE_OG_MODE === "real-chain"
      ? "real-chain"
      : "dev";
}

async function collectFiles(
  cwd: string,
  config: VibeTraceConfig
): Promise<Array<{ path: string; hash: string; size: number }>> {
  const files: Array<{ path: string; hash: string; size: number }> = [];
  const ignorePatterns = unique([
    ...config.snapshot.ignore,
    ...(config.publish.publicBundlePath ? [config.publish.publicBundlePath] : [])
  ]);

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const relativePath = relative(cwd, absolute).replaceAll("\\", "/");
      if (matchesIgnore(relativePath + (entry.isDirectory() ? "/" : ""), ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const data = await readFile(absolute);
        const stats = await stat(absolute);
        files.push({
          path: relative(cwd, absolute).replaceAll("\\", "/"),
          hash: canonicalHash(data.toString("base64")),
          size: stats.size
        });
      }
    }
  }

  await walk(cwd);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function discoverTraceFiles(cwd: string, config: VibeTraceConfig): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const relativePath = relative(cwd, absolute).replaceAll("\\", "/");

      if (entry.isDirectory()) {
        if (!shouldSkipTraceDirectory(relativePath)) {
          await walk(absolute);
        }
        continue;
      }

      if (entry.isFile() && relativePath.endsWith(".json") && matchesIgnore(relativePath, config.traces.include)) {
        files.push(relativePath);
      }
    }
  }

  await walk(cwd);
  return files.sort((a, b) => a.localeCompare(b));
}

function shouldSkipTraceDirectory(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  if ([".git", "node_modules", "dist", ".next", "coverage"].includes(normalized)) return true;
  return normalized.startsWith(".vibetrace/") && !normalized.startsWith(".vibetrace/inbox");
}

async function readGitState(
  cwd: string,
  files: Array<{ path: string; hash: string; size: number }>
): Promise<{ commit: string; branch: string }> {
  try {
    const [{ stdout: commit }, { stdout: branch }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["branch", "--show-current"], { cwd })
    ]);
    return {
      commit: commit.trim(),
      branch: branch.trim() || "detached"
    };
  } catch {
    return {
      commit: canonicalHash(files).slice(0, 14),
      branch: "no-git"
    };
  }
}

async function readLedger(cwd: string): Promise<LocalLedger> {
  try {
    return JSON.parse(await readFile(ledgerPath(cwd), "utf8")) as LocalLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No VibeTrace workspace found. Run vibetrace init first.");
    }
    throw error;
  }
}

async function writeLedger(cwd: string, ledger: LocalLedger): Promise<void> {
  await mkdir(ledgerDir(cwd), { recursive: true });
  await writeFile(ledgerPath(cwd), `${canonicalStringify(ledger)}\n`, "utf8");
}

async function readConfig(cwd: string): Promise<VibeTraceConfig> {
  const packageJson = await readPackageJson(cwd);
  if (!(await exists(configPath(cwd)))) {
    return defaultConfig(packageJson);
  }

  const input = JSON.parse(await readFile(configPath(cwd), "utf8")) as Partial<VibeTraceConfig>;
  const defaults = defaultConfig(packageJson);
  return {
    schemaVersion: "vibetrace.config.v1",
    project: {
      ...defaults.project,
      ...(input.project ?? {})
    },
    privacy: {
      redaction: "private-by-default"
    },
    snapshot: {
      ignore: unique([...(defaults.snapshot.ignore ?? []), ...((input.snapshot as { ignore?: string[] } | undefined)?.ignore ?? [])])
    },
    traces: {
      include: unique([...(defaults.traces.include ?? []), ...((input.traces as { include?: string[] } | undefined)?.include ?? [])])
    },
    publish: {
      ...defaults.publish,
      ...(input.publish ?? {})
    }
  };
}

async function ensureConfig(cwd: string, packageJson: Record<string, unknown>): Promise<VibeTraceConfig> {
  if (await exists(configPath(cwd))) {
    return readConfig(cwd);
  }

  const config = defaultConfig(packageJson);
  await writeFile(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

async function ensureCiWorkflow(cwd: string, packageManager: PackageManager): Promise<string | undefined> {
  const workflowPath = join(".github", "workflows", "vibetrace.yml");
  const absolutePath = join(cwd, workflowPath);
  if (await exists(absolutePath)) {
    return undefined;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, ciWorkflowContent(packageManager), "utf8");
  return workflowPath;
}

async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  const block = "# VibeTrace private ledger\n.vibetrace/\n";
  const existing = (await exists(path)) ? await readFile(path, "utf8") : "";
  if (existing.includes(".vibetrace/")) {
    return;
  }

  const separator = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  await writeFile(path, `${existing}${separator}${block}`, "utf8");
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
    return {
      name: data.name,
      version: data.version,
      scripts: data.scripts,
      dependencies: data.dependencies,
      devDependencies: data.devDependencies
    };
  } catch {
    return {};
  }
}

function defaultConfig(packageJson: Record<string, unknown>): VibeTraceConfig {
  return {
    schemaVersion: "vibetrace.config.v1",
    project: {
      name: String(packageJson.name ?? "unnamed-project")
    },
    privacy: {
      redaction: "private-by-default"
    },
    snapshot: {
      ignore: [
        ".git/**",
        ".vibetrace/**",
        "node_modules/**",
        "dist/**",
        ".next/**",
        "coverage/**",
        "playwright-report/**",
        "test-results/**",
        ".env*",
        "*.log"
      ]
    },
    traces: {
      include: [
        ".agenttrace/*.json",
        ".agenttrace/**/*.json",
        ".vibetrace/inbox/*.json",
        ".vibetrace/inbox/**/*.json",
        "agenttrace/*.json",
        "agenttrace/**/*.json",
        "ai-traces/*.json",
        "ai-traces/**/*.json",
        "trace.json",
        "traces/*.json",
        "traces/**/*.json",
        "vibetrace.trace.json"
      ]
    },
    publish: {
      publicBundlePath: "public/vibetrace.json",
      registryUrl: defaultRegistryUrl
    }
  };
}

function appendTraceSpans(ledger: LocalLedger, spans: TraceSpan[]): { added: number; skipped: number } {
  const seen = new Set(ledger.traces.map(traceIdentity));
  let added = 0;
  let skipped = 0;

  for (const span of spans) {
    const identity = traceIdentity(span);
    if (seen.has(identity)) {
      skipped += 1;
      continue;
    }

    ledger.traces.push(span);
    seen.add(identity);
    added += 1;
  }

  return { added, skipped };
}

function traceIdentity(span: TraceSpan): string {
  return `${span.spanId}:${span.promptHash}:${span.responseHash}`;
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if ((await exists(join(cwd, "pnpm-lock.yaml"))) || (await exists(join(cwd, "pnpm-workspace.yaml")))) return "pnpm";
  if ((await exists(join(cwd, "package-lock.json"))) || (await exists(join(cwd, "npm-shrinkwrap.json")))) return "npm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  if ((await exists(join(cwd, "bun.lock"))) || (await exists(join(cwd, "bun.lockb")))) return "bun";
  return "pnpm";
}

function ciWorkflowContent(packageManager: PackageManager): string {
  const setup = workflowPackageManagerSteps(packageManager);
  return `name: VibeTrace

on:
  workflow_dispatch:
  push:
    branches: [main]
  pull_request:

jobs:
  vibetrace:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      VIBETRACE_REGISTRY_URL: \${{ vars.VIBETRACE_REGISTRY_URL }}
      VIBETRACE_VIEWER_URL: \${{ vars.VIBETRACE_VIEWER_URL }}
      # DEFAULT path — point at a VibeTrace relayer. It funds ALL 0G writes (anchor + storage +
      # compute) with its own key, so this workflow needs NO funded key of its own.
      VIBETRACE_RELAYER_URL: \${{ vars.VIBETRACE_RELAYER_URL }}
      VIBETRACE_RELAYER_AUTH_TOKEN: \${{ secrets.VIBETRACE_RELAYER_AUTH_TOKEN }}
      # ADVANCED (self-hosted) — leave UNSET to use the hosted relayer above. Set VIBETRACE_OG_MODE
      # (real / real-chain) plus your OWN funded VIBETRACE_0G_PRIVATE_KEY to anchor locally instead.
      VIBETRACE_OG_MODE: \${{ vars.VIBETRACE_OG_MODE }}
      VIBETRACE_0G_CHAIN_ID: \${{ vars.VIBETRACE_0G_CHAIN_ID }}
      VIBETRACE_0G_RPC_URL: \${{ vars.VIBETRACE_0G_RPC_URL }}
      VIBETRACE_0G_STORAGE_INDEXER: \${{ vars.VIBETRACE_0G_STORAGE_INDEXER }}
      VIBETRACE_0G_STORAGE_FINALITY: \${{ vars.VIBETRACE_0G_STORAGE_FINALITY }}
      VIBETRACE_0G_PRIVATE_KEY: \${{ secrets.VIBETRACE_0G_PRIVATE_KEY }}
    steps:
      - uses: actions/checkout@v4
${setup}
      - name: Generate VibeTrace public bundle
        run: ${workflowRunCommand(packageManager)}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: vibetrace-public-bundle
          path: public/vibetrace.json
          if-no-files-found: ignore
`;
}

function workflowPackageManagerSteps(packageManager: PackageManager): string {
  switch (packageManager) {
    case "npm":
      return `
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
`;
    case "yarn":
      return `
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn

      - run: corepack enable
      - run: yarn install --immutable || yarn install --frozen-lockfile
`;
    case "bun":
      return `
      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile
`;
    case "pnpm":
      return `
      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
`;
  }
}

function workflowRunCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case "npm":
      return "npx vibetrace ci";
    case "yarn":
      return "yarn vibetrace ci";
    case "bun":
      return "bunx vibetrace ci";
    case "pnpm":
      return "pnpm exec vibetrace ci";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasGit(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function defaultClaims(): ClaimInput[] {
  return [
    { claimId: "claim-0g-storage", text: "Uses or integrates 0G Storage", selectors: ["0g", "storage"], evidence: "external" },
    { claimId: "claim-0g-compute", text: "Uses or integrates 0G Compute", selectors: ["0g", "compute"], evidence: "external" },
    {
      claimId: "claim-tee-attested",
      text: "Examined by an inference running in an attested 0G Compute TEE (execution attested by the provider's 0G TEE signer named by the attestation)",
      selectors: ["0g", "compute", "tee", "attest"],
      evidence: "external"
    },
    { claimId: "claim-ai-build", text: "Includes AI-assisted build trace evidence", selectors: ["src", "app", "package"], evidence: "trace" }
  ];
}

function stripTraceExcerpts(span: TraceSpan): Omit<TraceSpan, "promptExcerpt" | "responseExcerpt"> {
  const { promptExcerpt: _promptExcerpt, responseExcerpt: _responseExcerpt, ...publicSpan } = span;
  return publicSpan;
}

function ledgerDir(cwd: string): string {
  return join(cwd, workspaceDir);
}

function ledgerPath(cwd: string): string {
  return join(ledgerDir(cwd), ledgerFile);
}

function configPath(cwd: string): string {
  return join(cwd, configFile);
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function matchesIgnore(path: string, patterns: string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => patternMatchesPath(pattern, normalized));
}

function patternMatchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const pathWithoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return pathWithoutTrailingSlash === prefix || path.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.endsWith("/")) {
    return path.startsWith(normalizedPattern);
  }

  if (!normalizedPattern.includes("/") && path.startsWith(`${normalizedPattern}/`)) {
    return true;
  }

  return globToRegExp(normalizedPattern).test(pathWithoutTrailingSlash);
}

function globToRegExp(pattern: string): RegExp {
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
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function resolveInsideProject(cwd: string, targetPath: string): string {
  const resolved = resolve(cwd, targetPath);
  const relativePath = relative(cwd, resolved);
  if (relativePath === ".." || relativePath.startsWith(`..${"/"}`) || resolve(relativePath) === relativePath) {
    throw new Error(`Refusing to write outside the project: ${targetPath}`);
  }
  // Defense against symlink escape (e.g. `public -> /home/user/.config`): the
  // lexical check above passes for a symlinked component, so resolve REAL paths
  // and re-check containment. The target may not exist yet, so realpath the
  // nearest existing ancestor.
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve(cwd);
  }
  let probe = resolved;
  while (!existsSync(probe) && dirname(probe) !== probe) {
    probe = dirname(probe);
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  const realPrefix = realCwd.endsWith("/") ? realCwd : `${realCwd}/`;
  if (realProbe !== realCwd && !realProbe.startsWith(realPrefix)) {
    throw new Error(`Refusing to write through a symlink outside the project: ${targetPath}`);
  }
  return resolved;
}

export function buildViewerUrl(baseUrl: string, bundleHash: string): string {
  // Produce the registry story page URL: <baseUrl>#/p/<bundleHash>
  // This is always browser-navigable and does not require the bundle to be served
  // over HTTP separately — the registry already has it after submission.
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/#/p/${bundleHash}`;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function helpText(): string {
  return `VibeTrace

Run with no arguments to collect local AI-agent traces, publish, and register
to the leaderboard in one shot (same as 'vibetrace ship').

Commands:
  vibetrace                         one-shot: collect -> publish -> register
  vibetrace ship [--out ...] [--viewer-url ...] [--include-excerpts]
  vibetrace collect [--yes] [--include-excerpts]
  vibetrace init [--ci]
  vibetrace ci [--out public/vibetrace.json] [--viewer-url https://viewer.example]
  vibetrace snapshot
  vibetrace import --file trace.json
  vibetrace verify [--private-packet [--yes]] [--redact <glob> ...]
  vibetrace publish --public-summary [--out public/vibetrace.json] [--viewer-url https://viewer.example]
  vibetrace inspect [--json]
  vibetrace doctor [--json]`;
}

/**
 * True when this module is the program entry. Compares REAL paths so it still
 * fires when invoked through an npm `bin` symlink (e.g. `npx vibetrace`), where
 * process.argv[1] is the symlink but import.meta.url is the real file — the
 * naive `file://${argv[1]}` check silently fails there, making the CLI a no-op.
 */
function invokedAsMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
