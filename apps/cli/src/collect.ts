import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { TraceSpan } from "@vibetrace/schema";

/**
 * vibetrace collect — reads LOCAL AI-agent session transcripts (Claude Code)
 * and emits one honest TraceSpan per session that ran in THIS repo.
 *
 * PRIVACY: by default the emitted spans contain ONLY content hashes, file
 * paths, timestamps, and the model. Prompt/response TEXT is never written
 * unless the caller explicitly opts in via { includeExcerpts: true }, and even
 * then excerpts are heavily truncated. Reads are local-only; nothing is
 * uploaded by this module.
 */

/** A single JSON Lines record from a Claude Code session transcript. */
export type ClaudeRecord = {
  type?: string;
  sessionId?: string;
  agentId?: string;       // present in subagent transcript files
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;  // true in subagent files (useful for filtering journal.jsonl)
  message?: {
    model?: string;
    role?: string;
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
};

const AI_TOUCH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function sha256Hex(text: string): string {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Extract concatenated plain text from a record's message.content. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Iterate tool_use blocks of an assistant message. */
function* toolUses(content: unknown): Generator<{ name: string; filePath: string }> {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; name?: string; input?: { file_path?: string } };
      if (b.type === "tool_use" && typeof b.name === "string") {
        const filePath = b.input?.file_path;
        if (typeof filePath === "string" && filePath.length > 0) {
          yield { name: b.name, filePath };
        }
      }
    }
  }
}

function slugFromSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `claude-code:${cleaned || "session"}`;
}

export type BuildSpanOptions = {
  /** Absolute, realpath'd repo root. */
  repoRoot: string;
  /** Predicate: does this absolute path currently exist? */
  fileExists: (absPath: string) => boolean;
  /** Current time as ISO; endedAt is clamped to be <= this. */
  now: string;
  /** Opt-in: include heavily-truncated text excerpts. Default false. */
  includeExcerpts?: boolean;
};

export type BuildSpanFromAgentOptions = BuildSpanOptions & {
  /** When processing a subagent file, pass its agentId so the spanId and metadata are agent-scoped. */
  agentId?: string;
};

/**
 * Like buildSpanFromSession but scoped to a single agent run.
 * When agentId is provided, the spanId is claude-code:<agentId> and
 * metadata.agentId is set.  When absent, behaves identically to
 * buildSpanFromSession (main-thread path).
 */
export function buildSpanFromAgent(
  records: ClaudeRecord[],
  options: BuildSpanFromAgentOptions
): TraceSpan | undefined {
  const repoRoot = options.repoRoot;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;

  const agentId = options.agentId;
  let sessionId: string | undefined;
  const cwds = new Set<string>();
  const modelCounts = new Map<string, number>();
  let first: string | undefined;
  let last: string | undefined;
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  const produced = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;

  const underRepo = (absPath: string): boolean =>
    absPath === repoRoot || absPath.startsWith(prefix);

  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.cwd.length > 0) cwds.add(rec.cwd);

    const ts = rec.timestamp;
    if (typeof ts === "string" && ts.length > 0) {
      if (first === undefined || ts < first) first = ts;
      if (last === undefined || ts > last) last = ts;
    }

    const type = rec.type;
    const message = rec.message;

    if (type === "user") {
      const text = extractText(message?.content);
      if (text.trim().length > 0) userTexts.push(text);
    } else if (type === "assistant" && message) {
      const model = message.model;
      if (typeof model === "string" && model.length > 0 && model !== "<synthetic>") {
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
      }
      const text = extractText(message.content);
      if (text.trim().length > 0) assistantTexts.push(text);
      const usage = message.usage;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
      }
      for (const { name, filePath } of toolUses(message.content)) {
        const abs = resolve(filePath);
        if (!underRepo(abs)) continue;
        if (!options.fileExists(abs)) continue;
        const rel = relative(repoRoot, abs).replaceAll("\\", "/");
        if (AI_TOUCH_TOOLS.has(name)) produced.add(rel);
      }
    }
  }

  // cwd scoping: the agent must have run in THIS repo — root OR a descendant
  // directory (consistent with the Codex collector; repoRoot is realpath'd by
  // the caller). Without descendant matching, sessions started from e.g.
  // /repo/packages/score are silently skipped.
  let ranInRepo = false;
  for (const c of cwds) {
    if (c === repoRoot || c.startsWith(prefix)) {
      ranInRepo = true;
      break;
    }
  }
  if (!ranInRepo) return undefined;
  if (!sessionId && !agentId) return undefined;

  // Predominant model; skip agents with no real model.
  let model: string | undefined;
  let best = -1;
  for (const [m, count] of modelCounts) {
    if (count > best) {
      best = count;
      model = m;
    }
  }
  if (!model) return undefined;

  if (first === undefined) return undefined;

  let endedAt = last ?? first;
  if (endedAt > options.now) endedAt = options.now;
  let startedAt = first;
  if (startedAt > endedAt) startedAt = endedAt;

  const promptHash = sha256Hex(userTexts.join("\n"));
  const responseHash = sha256Hex(assistantTexts.join("\n"));

  const metadata: Record<string, unknown> = {
    source: "claude-code-collect",
    sessionId: sessionId ?? agentId ?? "unknown"
  };
  if (agentId) metadata.agentId = agentId;
  if (inputTokens > 0 || outputTokens > 0) {
    metadata.tokens = { input: inputTokens, output: outputTokens };
  }

  // spanId: scoped to the agent when agentId is present, otherwise to the session.
  const identifier = agentId ?? sessionId ?? "unknown";
  const span: TraceSpan = {
    spanId: slugFromSessionId(identifier),
    tool: "claude-code",
    model,
    startedAt,
    endedAt,
    promptHash,
    responseHash,
    filesMentioned: [],
    artifactsProduced: [...produced].sort(),
    metadata
  };

  if (options.includeExcerpts) {
    const redact = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (userTexts.length) span.promptExcerpt = redact(userTexts.join(" "));
    if (assistantTexts.length) span.responseExcerpt = redact(assistantTexts.join(" "));
  }

  return span;
}

/**
 * Pure parser: turn one session's records into a single honest TraceSpan, or
 * undefined if the session never ran in this repo or produced nothing usable.
 *
 * - tool = "claude-code"
 * - model = predominant assistant model (synthetic models ignored)
 * - startedAt/endedAt = first/last record timestamps (endedAt clamped <= now)
 * - artifactsProduced = distinct REPO-RELATIVE Write/Edit/MultiEdit/NotebookEdit
 *   file_paths under repoRoot that EXIST now (paths are relative to repoRoot,
 *   forward-slashed, so they match the snapshot FileVersion.path convention the
 *   graph joins on)
 * - filesMentioned = reserved for non-mutating references; mutating edit tools
 *   are counted as produced artifacts because they are AI-touched files
 * - promptHash/responseHash = real sha256 over concatenated user/assistant text
 */
export function buildSpanFromSession(
  records: ClaudeRecord[],
  options: BuildSpanOptions
): TraceSpan | undefined {
  return buildSpanFromAgent(records, options);
}

/** Parse a JSON Lines transcript into records, skipping malformed lines. */
export function parseJsonl(content: string): ClaudeRecord[] {
  const records: ClaudeRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ClaudeRecord);
    } catch {
      // Skip malformed lines — transcripts can be partially written.
    }
  }
  return records;
}

export type CollectResult = {
  spans: TraceSpan[];
  sessionsScanned: number;
  sessionsMatched: number;
  scannedDirs: string[];
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover Claude Code sessions whose cwd === repoRoot and collect one honest
 * span per matching session. Matching is by the cwd field inside each
 * transcript — NOT by the encoded directory name — so renamed/moved repos and
 * shared-prefix paths are handled correctly.
 */
export async function collectClaudeCode(params: {
  repoRoot: string;
  now: string;
  includeExcerpts?: boolean;
  home?: string;
}): Promise<CollectResult> {
  const home = params.home ?? homedir();
  const projectsDir = join(home, ".claude", "projects");
  const scannedDirs = [projectsDir];

  const result: CollectResult = {
    spans: [],
    sessionsScanned: 0,
    sessionsMatched: 0,
    scannedDirs
  };

  if (!(await exists(projectsDir))) return result;

  const fileExistsCache = new Map<string, boolean>();
  const fileExists = (absPath: string): boolean => {
    const cached = fileExistsCache.get(absPath);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      ok = existsSync(absPath);
    } catch {
      ok = false;
    }
    fileExistsCache.set(absPath, ok);
    return ok;
  };

  // Collect all *.jsonl paths recursively under each project-dir entry.
  async function gatherJsonl(dir: string): Promise<string[]> {
    const paths: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return paths;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...(await gatherJsonl(abs)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        // journal.jsonl files are workflow event logs — they carry null cwd/sessionId,
        // so they would be ignored by buildSpanFromAgent anyway, but skip them early
        // to save I/O and avoid inflating sessionsScanned.
        if (entry.name !== "journal.jsonl") {
          paths.push(abs);
        }
      }
    }
    return paths;
  }

  // Group records by agentId (subagents) or by file path (main-thread top-level files
  // which have no agentId). Key = agentId when present, else the absolute file path.
  const groups = new Map<string, { records: ClaudeRecord[]; agentId?: string }>();

  const topEntries = await readdir(projectsDir, { withFileTypes: true });
  for (const entry of topEntries) {
    const dirOrFile = join(projectsDir, entry.name);
    let filePaths: string[] = [];
    if (entry.isDirectory()) {
      filePaths = await gatherJsonl(dirOrFile);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
      filePaths = [dirOrFile];
    }

    for (const filePath of filePaths) {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const records = parseJsonl(content);
      for (const rec of records) {
        const aid = typeof rec.agentId === "string" && rec.agentId.length > 0 ? rec.agentId : undefined;
        // Group key: agentId for subagent files, else file path for main-thread files.
        const key = aid ?? filePath;
        const existing = groups.get(key);
        if (existing) {
          existing.records.push(rec);
        } else {
          groups.set(key, { records: [rec], agentId: aid });
        }
      }
    }
  }

  // Emit one span per group.
  for (const { records, agentId } of groups.values()) {
    result.sessionsScanned += 1;
    const span = buildSpanFromAgent(records, {
      repoRoot: params.repoRoot,
      fileExists,
      now: params.now,
      includeExcerpts: params.includeExcerpts,
      agentId
    });
    if (span) {
      result.sessionsMatched += 1;
      result.spans.push(span);
    }
  }

  result.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
  return result;
}
