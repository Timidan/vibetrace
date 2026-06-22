import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSpanFromSession, buildSpanFromAgent, parseJsonl, collectClaudeCode, type ClaudeRecord } from "./collect";

const REPO = "/home/dev/myrepo";
const NOW = "2026-06-17T12:00:00.000Z";

function fakeSession(repo: string): ClaudeRecord[] {
  return [
    { type: "user", sessionId: "abc-123", cwd: repo, timestamp: "2026-06-17T10:00:00.000Z", message: { role: "user", content: "please build the thing" } },
    {
      type: "assistant",
      sessionId: "abc-123",
      timestamp: "2026-06-17T10:01:00.000Z",
      message: {
        model: "claude-opus-4-8",
        role: "assistant",
        content: [
          { type: "text", text: "writing files now" },
          { type: "tool_use", name: "Write", input: { file_path: `${repo}/src/new.ts` } },
          { type: "tool_use", name: "Edit", input: { file_path: `${repo}/src/old.ts` } },
          { type: "tool_use", name: "Write", input: { file_path: `${repo}/src/ghost.ts` } }
        ],
        usage: { input_tokens: 100, output_tokens: 200 }
      }
    },
    { type: "assistant", sessionId: "abc-123", timestamp: "2026-06-17T10:02:00.000Z", message: { model: "claude-opus-4-8", role: "assistant", content: [{ type: "text", text: "done" }] } }
  ];
}

// Only new.ts and old.ts "exist"; ghost.ts does not.
const existing = new Set([`${REPO}/src/new.ts`, `${REPO}/src/old.ts`]);
const fileExists = (p: string): boolean => existing.has(p);

describe("buildSpanFromSession", () => {
  it("maps Write and genuine edit tools to artifactsProduced for existing files only", () => {
    const span = buildSpanFromSession(fakeSession(REPO), { repoRoot: REPO, fileExists, now: NOW });
    expect(span).toBeDefined();
    // Repo-relative paths so they match snapshot FileVersion.path in the graph join.
    expect(span!.artifactsProduced).toEqual(["src/new.ts", "src/old.ts"]); // ghost.ts excluded (doesn't exist)
    expect(span!.filesMentioned).toEqual([]);
    expect(span!.tool).toBe("claude-code");
    expect(span!.model).toBe("claude-opus-4-8");
    expect(span!.metadata.source).toBe("claude-code-collect");
    expect(span!.metadata.sessionId).toBe("abc-123");
    expect((span!.metadata.tokens as { input: number }).input).toBe(100);
  });

  it("counts Edit, MultiEdit, and NotebookEdit touched files as coverage artifacts", () => {
    const records: ClaudeRecord[] = [
      { type: "user", sessionId: "edit-session", cwd: REPO, timestamp: "2026-06-17T10:00:00.000Z", message: { content: "edit files" } },
      {
        type: "assistant",
        sessionId: "edit-session",
        timestamp: "2026-06-17T10:01:00.000Z",
        message: {
          model: "claude-opus-4-8",
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: `${REPO}/src/old.ts` } },
            { type: "tool_use", name: "MultiEdit", input: { file_path: `${REPO}/src/multi.ts` } },
            { type: "tool_use", name: "NotebookEdit", input: { file_path: `${REPO}/notebooks/demo.ipynb` } },
            { type: "tool_use", name: "Edit", input: { file_path: "/home/dev/other/src/outside.ts" } }
          ]
        }
      }
    ];
    const editExists = (p: string): boolean =>
      new Set([
        `${REPO}/src/old.ts`,
        `${REPO}/src/multi.ts`,
        `${REPO}/notebooks/demo.ipynb`,
        "/home/dev/other/src/outside.ts"
      ]).has(p);

    const span = buildSpanFromSession(records, { repoRoot: REPO, fileExists: editExists, now: NOW });

    expect(span!.artifactsProduced).toEqual(["notebooks/demo.ipynb", "src/multi.ts", "src/old.ts"]);
    expect(span!.filesMentioned).toEqual([]);
    expect(JSON.stringify(span!.artifactsProduced)).not.toContain(REPO);
    expect(JSON.stringify(span!.artifactsProduced)).not.toContain("/home/dev/other");
  });

  it("scopes by cwd — a session run in another repo is ignored", () => {
    const span = buildSpanFromSession(fakeSession("/home/dev/other"), { repoRoot: REPO, fileExists, now: NOW });
    expect(span).toBeUndefined();
  });

  it("produces real sha256 hashes (0x + 64 hex) over the session text", () => {
    const span = buildSpanFromSession(fakeSession(REPO), { repoRoot: REPO, fileExists, now: NOW });
    expect(span!.promptHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(span!.responseHash).toMatch(/^0x[a-f0-9]{64}$/);
    const expectedPrompt = "0x" + createHash("sha256").update("please build the thing", "utf8").digest("hex");
    const expectedResponse =
      "0x" + createHash("sha256").update(["writing files now", "done"].join("\n"), "utf8").digest("hex");
    expect(span!.promptHash).toBe(expectedPrompt);
    expect(span!.responseHash).toBe(expectedResponse);
  });

  it("excludes prompt/response TEXT by default", () => {
    const span = buildSpanFromSession(fakeSession(REPO), { repoRoot: REPO, fileExists, now: NOW });
    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain("please build the thing");
    expect(serialized).not.toContain("writing files now");
    expect(span!.promptExcerpt).toBeUndefined();
    expect(span!.responseExcerpt).toBeUndefined();
  });

  it("includes redacted excerpts only when opted in", () => {
    const span = buildSpanFromSession(fakeSession(REPO), {
      repoRoot: REPO,
      fileExists,
      now: NOW,
      includeExcerpts: true
    });
    expect(span!.promptExcerpt).toContain("please build the thing");
    expect(span!.responseExcerpt).toContain("writing files now");
  });

  it("clamps endedAt to now so the temporal gate passes", () => {
    const future: ClaudeRecord[] = [
      { type: "user", sessionId: "s", cwd: REPO, timestamp: "2026-06-17T09:00:00.000Z", message: { content: "hi" } },
      { type: "assistant", sessionId: "s", timestamp: "2030-01-01T00:00:00.000Z", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "x" }] } }
    ];
    const span = buildSpanFromSession(future, { repoRoot: REPO, fileExists, now: NOW });
    expect(span!.endedAt).toBe(NOW);
    expect(span!.endedAt <= NOW).toBe(true);
  });

  it("ignores synthetic-only sessions (no real model)", () => {
    const synth: ClaudeRecord[] = [
      { type: "user", sessionId: "s", cwd: REPO, timestamp: "2026-06-17T09:00:00.000Z", message: { content: "hi" } },
      { type: "assistant", sessionId: "s", timestamp: "2026-06-17T09:01:00.000Z", message: { model: "<synthetic>", content: [{ type: "text", text: "x" }] } }
    ];
    expect(buildSpanFromSession(synth, { repoRoot: REPO, fileExists, now: NOW })).toBeUndefined();
  });

  it("picks the predominant model when several appear", () => {
    const mixed = fakeSession(REPO);
    mixed.push({ type: "assistant", sessionId: "abc-123", timestamp: "2026-06-17T10:03:00.000Z", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "y" }] } });
    // opus appears twice, sonnet once -> opus wins
    const span = buildSpanFromSession(mixed, { repoRoot: REPO, fileExists, now: NOW });
    expect(span!.model).toBe("claude-opus-4-8");
  });
});

describe("parseJsonl", () => {
  it("parses valid lines and skips malformed ones", () => {
    const content = '{"type":"user","sessionId":"a"}\nnot json\n\n{"type":"assistant"}\n';
    const records = parseJsonl(content);
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe("user");
    expect(records[1].type).toBe("assistant");
  });

  it("round-trips a real jsonl fixture written to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibetrace-collect-"));
    const file = join(dir, "session.jsonl");
    const lines = fakeSession(REPO).map((r) => JSON.stringify(r));
    await writeFile(file, lines.join("\n") + "\n");
    const { readFile } = await import("node:fs/promises");
    const records = parseJsonl(await readFile(file, "utf8"));
    const span = buildSpanFromSession(records, { repoRoot: REPO, fileExists, now: NOW });
    expect(span!.artifactsProduced).toEqual(["src/new.ts", "src/old.ts"]);
    expect(span!.filesMentioned).toEqual([]);
  });
});

describe("buildSpanFromAgent", () => {
  it("uses agentId as the spanId key when agentId is provided", () => {
    const records: ClaudeRecord[] = [
      { type: "user", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, cwd: REPO, timestamp: "2026-06-17T10:00:00.000Z", message: { content: "do work" } },
      { type: "assistant", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, timestamp: "2026-06-17T10:01:00.000Z", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "done" }] } }
    ];
    const span = buildSpanFromAgent(records, { repoRoot: REPO, fileExists, now: NOW, agentId: "agent-abc" });
    expect(span).toBeDefined();
    expect(span!.spanId).toBe("claude-code:agent-abc");
    expect(span!.metadata.agentId).toBe("agent-abc");
    expect(span!.metadata.sessionId).toBe("sess-xyz");
    expect(span!.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to sessionId-based spanId when no agentId is provided (main-thread path)", () => {
    const span = buildSpanFromAgent(fakeSession(REPO), { repoRoot: REPO, fileExists, now: NOW });
    expect(span!.spanId).toBe("claude-code:abc-123");
    expect(span!.metadata.agentId).toBeUndefined();
  });

  it("returns undefined for a subagent that ran in a different repo", () => {
    const records: ClaudeRecord[] = [
      { type: "user", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, cwd: "/other/repo", timestamp: "2026-06-17T10:00:00.000Z", message: { content: "hi" } },
      { type: "assistant", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, timestamp: "2026-06-17T10:01:00.000Z", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "done" }] } }
    ];
    expect(buildSpanFromAgent(records, { repoRoot: REPO, fileExists, now: NOW, agentId: "agent-abc" })).toBeUndefined();
  });

  it("excludes prompt/response text by default (privacy rule)", () => {
    const records: ClaudeRecord[] = [
      { type: "user", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, cwd: REPO, timestamp: "2026-06-17T10:00:00.000Z", message: { content: "secret subagent prompt" } },
      { type: "assistant", agentId: "agent-abc", sessionId: "sess-xyz", isSidechain: true, timestamp: "2026-06-17T10:01:00.000Z", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "secret subagent response" }] } }
    ];
    const span = buildSpanFromAgent(records, { repoRoot: REPO, fileExists, now: NOW, agentId: "agent-abc" });
    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain("secret subagent prompt");
    expect(serialized).not.toContain("secret subagent response");
    expect(span!.promptExcerpt).toBeUndefined();
    expect(span!.responseExcerpt).toBeUndefined();
  });

  it("emits repo-relative paths (not absolute) for produced and mentioned files", () => {
    const records: ClaudeRecord[] = [
      { type: "user", agentId: "a1", sessionId: "s1", cwd: REPO, timestamp: "2026-06-17T10:00:00.000Z", message: { content: "hi" } },
      {
        type: "assistant", agentId: "a1", sessionId: "s1", timestamp: "2026-06-17T10:01:00.000Z",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", name: "Write", input: { file_path: `${REPO}/src/new.ts` } },
            { type: "tool_use", name: "Edit",  input: { file_path: `${REPO}/src/old.ts` } }
          ]
        }
      }
    ];
    const span = buildSpanFromAgent(records, { repoRoot: REPO, fileExists, now: NOW, agentId: "a1" });
    expect(span!.artifactsProduced).toEqual(["src/new.ts", "src/old.ts"]);
    expect(span!.filesMentioned).toEqual([]);
    // Confirm no absolute paths leaked
    expect(JSON.stringify(span!.artifactsProduced)).not.toContain(REPO);
    expect(JSON.stringify(span!.filesMentioned)).not.toContain(REPO);
  });
});

describe("collectClaudeCode — recursive subagent discovery", () => {
  it("discovers subagent transcripts under session-uuid/subagents/ directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibetrace-home-"));
    const repo = await mkdtemp(join(tmpdir(), "vibetrace-repo-"));
    // Create a fake file the agent will "produce"
    await writeFile(join(repo, "out.ts"), "export const x = 1;\n");

    const projectsDir = join(home, ".claude", "projects", "fake-project");
    const sessionId = "sess-111";
    const agentId = "agent-aaa";

    // Top-level session file (main thread) — produces nothing but establishes cwd
    const topLevelSession = join(projectsDir, `${sessionId}.jsonl`);
    await mkdir(projectsDir, { recursive: true });
    const mainRecord: ClaudeRecord = {
      type: "user",
      sessionId,
      cwd: repo,
      timestamp: "2026-06-17T10:00:00.000Z",
      message: { content: "start" }
    };
    const mainAssistant: ClaudeRecord = {
      type: "assistant",
      sessionId,
      timestamp: "2026-06-17T10:01:00.000Z",
      message: { model: "claude-opus-4-8", content: [{ type: "text", text: "dispatching" }] }
    };
    await writeFile(topLevelSession, [mainRecord, mainAssistant].map(r => JSON.stringify(r)).join("\n") + "\n");

    // Subagent file under session-uuid/subagents/
    const subagentsDir = join(projectsDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const subagentFile = join(subagentsDir, `${agentId}.jsonl`);
    const subRecord: ClaudeRecord = {
      type: "user",
      agentId,
      sessionId,
      isSidechain: true,
      cwd: repo,
      timestamp: "2026-06-17T10:02:00.000Z",
      message: { content: "sub task" }
    };
    const subAssistant: ClaudeRecord = {
      type: "assistant",
      agentId,
      sessionId,
      isSidechain: true,
      timestamp: "2026-06-17T10:03:00.000Z",
      message: {
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "writing" },
          { type: "tool_use", name: "Write", input: { file_path: join(repo, "out.ts") } }
        ]
      }
    };
    await writeFile(subagentFile, [subRecord, subAssistant].map(r => JSON.stringify(r)).join("\n") + "\n");

    // journal.jsonl should be ignored
    await writeFile(join(subagentsDir, "journal.jsonl"), JSON.stringify({ type: "started", agentId: null, sessionId: null, cwd: null, isSidechain: null, timestamp: null }) + "\n");

    const result = await collectClaudeCode({ repoRoot: repo, now: NOW, home });

    // Should find 2 groups: main-thread session + subagent
    expect(result.sessionsScanned).toBeGreaterThanOrEqual(2);
    expect(result.sessionsMatched).toBeGreaterThanOrEqual(2);

    const spans = result.spans;
    const agentSpan = spans.find(s => s.spanId === `claude-code:${agentId}`);
    expect(agentSpan).toBeDefined();
    expect(agentSpan!.model).toBe("claude-sonnet-4-6");
    expect(agentSpan!.artifactsProduced).toEqual(["out.ts"]);
    expect(agentSpan!.metadata.agentId).toBe(agentId);
    expect(agentSpan!.metadata.sessionId).toBe(sessionId);

    const mainSpan = spans.find(s => s.spanId === `claude-code:${sessionId}`);
    expect(mainSpan).toBeDefined();
    expect(mainSpan!.model).toBe("claude-opus-4-8");
    expect(mainSpan!.metadata.agentId).toBeUndefined();

    // No text leak in any span (check content words, not substrings that appear in field names)
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain("dispatching");
    expect(serialized).not.toContain("writing");
    expect(serialized).not.toContain("sub task");
    // "start" appears in "startedAt" field name, so check the actual user message content
    expect(serialized).not.toContain('"start"');
    // Confirm no excerpt fields
    for (const span of spans) {
      expect((span as Record<string, unknown>).promptExcerpt).toBeUndefined();
      expect((span as Record<string, unknown>).responseExcerpt).toBeUndefined();
    }
  });

  it("does not double-count a file mentioned by two different agents", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibetrace-dedup-"));
    const repo = await mkdtemp(join(tmpdir(), "vibetrace-repo2-"));
    await writeFile(join(repo, "shared.ts"), "export const shared = true;\n");

    const projectsDir = join(home, ".claude", "projects", "proj");
    await mkdir(projectsDir, { recursive: true });

    // Two subagents both Edit the same file
    for (const [aid, ts] of [["agent-1", "2026-06-17T10:00:00.000Z"], ["agent-2", "2026-06-17T10:02:00.000Z"]] as [string, string][]) {
      const dir = join(projectsDir, "sess-222", "subagents");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${aid}.jsonl`), [
        JSON.stringify({ type: "user", agentId: aid, sessionId: "sess-222", cwd: repo, timestamp: ts, message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", agentId: aid, sessionId: "sess-222", timestamp: ts, message: { model: "claude-opus-4-8", content: [{ type: "tool_use", name: "Edit", input: { file_path: join(repo, "shared.ts") } }] } })
      ].join("\n") + "\n");
    }

    const result = await collectClaudeCode({ repoRoot: repo, now: NOW, home });
    // Two spans, each touching shared.ts as a coverage-counted artifact
    expect(result.spans).toHaveLength(2);
    // Distinct files across spans (coverage count) = 1 — confirmed by consumer, not this function,
    // but verify spans are correct
    for (const span of result.spans) {
      expect(span.artifactsProduced).toContain("shared.ts");
      expect(span.filesMentioned).not.toContain("shared.ts");
    }
  });
});
