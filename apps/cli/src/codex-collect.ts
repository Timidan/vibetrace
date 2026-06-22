import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TraceSpan } from "@vibetrace/schema";
import { makeRepoRemapper, type CollectResult } from "./collect.js";

/**
 * vibetrace collect (Codex) — reads LOCAL Codex CLI rollout transcripts
 * (~/.codex/sessions/**\/*.jsonl) and emits one honest TraceSpan per Codex
 * session that ran in THIS repo. This is the sibling of collect.ts: Codex edits
 * live OUTSIDE ~/.claude, so without this the gpt-5.x work on a repo is
 * completely uncredited.
 *
 * PRIVACY: identical posture to the Claude collector — emitted spans contain
 * ONLY content hashes, file paths, timestamps, and the model. Prompt/response
 * TEXT is never written unless { includeExcerpts: true }. Reads are local-only.
 *
 * Codex rollout schema (one JSON object per line):
 *   { timestamp, type, payload }
 *   - type "session_meta"  → payload.cwd (the workdir), payload.id (session id)
 *   - type "turn_context"  → payload.model (e.g. "gpt-5.5")
 *   - type "response_item" → payload.type:
 *        "message"          (payload.role + payload.content[] text)
 *        "custom_tool_call" name "apply_patch" → payload.input is a patch
 *           envelope with `*** Add|Update|Delete File: <path>` lines.
 */

/** A single JSON Lines record from a Codex rollout transcript. */
export type CodexRecord = {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    cwd?: string;
    id?: string;
    model?: string;
    name?: string;
    input?: unknown;
    role?: string;
    content?: unknown;
  };
};

function sha256Hex(text: string): string {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const FILE_OP_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

/** Extract file paths (relative to the session cwd) from an apply_patch envelope. */
export function patchFiles(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const files: string[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    const m = FILE_OP_RE.exec(line);
    if (m) {
      files.push(m[1].trim());
      continue;
    }
    // A rename is `*** Update File: old` followed by `*** Move to: new`. Attribute
    // the NEW path too — the old one won't exist after the move, so without this
    // the destination file gets no artifact credit (technical review finding).
    const mv = MOVE_RE.exec(line);
    if (mv) files.push(mv[1].trim());
  }
  return files;
}

/** Concatenate plain text from a Codex message content array (or string). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { text?: string };
      if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
    }
  }
  return parts.join("\n");
}

export type BuildCodexSpanOptions = {
  /** Absolute, realpath'd repo root. */
  repoRoot: string;
  /** Predicate: does this absolute path currently exist? */
  fileExists: (absPath: string) => boolean;
  /** Current time as ISO; endedAt is clamped to be <= this. */
  now: string;
  /** Opt-in: include heavily-truncated text excerpts. Default false. */
  includeExcerpts?: boolean;
  /** Former absolute paths of THIS repo (e.g. before a rename); aliased sessions count, paths remapped. */
  repoAliases?: string[];
};

/**
 * Pure parser: turn one Codex rollout session's records into a single honest
 * TraceSpan, or undefined if the session never ran in this repo or produced
 * nothing usable.
 *
 * - tool = "codex"
 * - model = predominant turn_context model (e.g. "gpt-5.5")
 * - artifactsProduced = distinct REPO-RELATIVE apply_patch file paths that EXIST
 *   now (resolved against the session cwd, then made relative to repoRoot)
 * - promptHash/responseHash = real sha256 over concatenated user/assistant text
 */
export function buildSpanFromCodexSession(
  records: CodexRecord[],
  options: BuildCodexSpanOptions
): TraceSpan | undefined {
  const repoRoot = options.repoRoot;
  const remapper = makeRepoRemapper(repoRoot, options.repoAliases);

  let cwd: string | undefined;
  let sessionId: string | undefined;
  const modelCounts = new Map<string, number>();
  let first: string | undefined;
  let last: string | undefined;
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  const produced = new Set<string>();

  for (const rec of records) {
    const ts = rec.timestamp;
    if (typeof ts === "string" && ts.length > 0) {
      if (first === undefined || ts < first) first = ts;
      if (last === undefined || ts > last) last = ts;
    }

    const p = rec.payload ?? {};
    if (rec.type === "session_meta") {
      if (typeof p.cwd === "string" && p.cwd.length > 0) cwd = p.cwd;
      if (typeof p.id === "string" && p.id.length > 0) sessionId = p.id;
    } else if (rec.type === "turn_context") {
      if (typeof p.model === "string" && p.model.length > 0) {
        modelCounts.set(p.model, (modelCounts.get(p.model) ?? 0) + 1);
      }
    } else if (rec.type === "response_item") {
      if (p.type === "message") {
        const text = messageText(p.content);
        if (text.trim().length > 0) {
          // Only real conversation turns; skip developer/system scaffolding.
          if (p.role === "assistant") assistantTexts.push(text);
          else if (p.role === "user") userTexts.push(text);
        }
      } else if (p.type === "custom_tool_call" && p.name === "apply_patch") {
        const base = cwd ?? repoRoot;
        for (const rel of patchFiles(p.input)) {
          const abs = isAbsolute(rel) ? rel : resolve(base, rel);
          const absInRepo = remapper.toRepoAbsolute(abs);
          if (absInRepo === null) continue; // not under this repo (or any alias)
          if (!options.fileExists(absInRepo)) continue;
          const r = relative(repoRoot, absInRepo).replaceAll("\\", "/");
          if (r && !r.startsWith("..")) produced.add(r);
        }
      }
    }
  }

  // cwd scoping: the session must have run in THIS repo (root, a subdir, or under a configured alias).
  if (!cwd || !remapper.isUnderRepo(cwd)) return undefined;
  if (!sessionId) return undefined;

  // Predominant model; skip sessions with no real model.
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

  const span: TraceSpan = {
    spanId: `codex:${sessionId}`,
    tool: "codex",
    model,
    startedAt,
    endedAt,
    promptHash: sha256Hex(userTexts.join("\n")),
    responseHash: sha256Hex(assistantTexts.join("\n")),
    filesMentioned: [],
    artifactsProduced: [...produced].sort(),
    metadata: { source: "codex-collect", sessionId }
  };

  if (options.includeExcerpts) {
    const redact = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (userTexts.length) span.promptExcerpt = redact(userTexts.join(" "));
    if (assistantTexts.length) span.responseExcerpt = redact(assistantTexts.join(" "));
  }

  return span;
}

/** Parse a JSON Lines Codex rollout into records, skipping malformed lines. */
export function parseCodexJsonl(content: string): CodexRecord[] {
  const records: CodexRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CodexRecord);
    } catch {
      // Skip malformed lines — transcripts can be partially written.
    }
  }
  return records;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover Codex rollout sessions whose cwd is THIS repo (root or a subdir) and
 * collect one honest span per matching session. One rollout file == one session.
 */
export async function collectCodex(params: {
  repoRoot: string;
  now: string;
  includeExcerpts?: boolean;
  repoAliases?: string[];
  home?: string;
}): Promise<CollectResult> {
  const home = params.home ?? homedir();
  const sessionsDir = join(home, ".codex", "sessions");
  const scannedDirs = [sessionsDir];

  const result: CollectResult = {
    spans: [],
    sessionsScanned: 0,
    sessionsMatched: 0,
    scannedDirs
  };

  if (!(await exists(sessionsDir))) return result;

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
        paths.push(abs);
      }
    }
    return paths;
  }

  const files = await gatherJsonl(sessionsDir);
  for (const filePath of files) {
    result.sessionsScanned += 1;
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const records = parseCodexJsonl(content);
    const span = buildSpanFromCodexSession(records, {
      repoRoot: params.repoRoot,
      fileExists,
      now: params.now,
      includeExcerpts: params.includeExcerpts,
      repoAliases: params.repoAliases
    });
    if (span) {
      result.sessionsMatched += 1;
      result.spans.push(span);
    }
  }

  result.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
  return result;
}
