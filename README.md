<div align="center">

<img src="docs/assets/logo-mark.svg" width="92" height="92" alt="VibeTrace" />

# VibeTrace

<!-- vibetrace-badge -->
[![VibeScore S](https://vibetrace.timidan.xyz/api/badge/4cb31b338ccefb26417de03613284504f339e5a5ffea59dff5325951af8a645b.svg)](https://vibetrace.timidan.xyz/#/p/4cb31b338ccefb26417de03613284504f339e5a5ffea59dff5325951af8a645b)
<!-- /vibetrace-badge -->

**Local-first proof-of-build ledger for AI-assisted software — trace real agent sessions, optionally anchor them on 0G, and publish a verifiable build story.**

<p>
  <img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img alt="CLI Node.js 18+" src="https://img.shields.io/badge/CLI_Node.js-18%2B-339933?logo=nodedotjs&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white" />
  <img alt="Tested with Vitest" src="https://img.shields.io/badge/tested_with-Vitest-6E9F18?logo=vitest&logoColor=white" />
  <img alt="ethers 6" src="https://img.shields.io/badge/ethers-6-2535A0?logo=ethereum&logoColor=white" />
  <a href="https://0g.ai"><img alt="0G — Storage, Chain, Compute" src="https://img.shields.io/badge/0G-Storage_·_Chain_·_Compute-000000" /></a>
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="#repo-map"><b>Repo map</b></a> ·
  <a href="#generic-trace-format"><b>Trace format</b></a> ·
  <a href="docs/integration.md"><b>Integration guide</b></a>
</p>

</div>

---

VibeTrace is a local-first proof-of-build ledger for AI-assisted software.
It compiles file/Git snapshots, generic AI trace imports, artifact lineage,
verifier outputs, and development or live 0G anchors into a private local
ledger. Publishing is explicit and produces a redacted public build story.

## Quick Start

One command, from inside any repo you've built with an AI agent:

```bash
npx vibetrace-cli
```

That single run is the whole flow: it **collects** your real local Claude Code
and Codex session traces for this repo, **snapshots** the repo, **verifies** the
artifact lineage, **publishes** a redacted public bundle, and **registers** you
on the leaderboard. On success it prints:

```
✓ You're on the board: http://localhost:5173/#/p/<id>
```

Privacy is enforced by default. `collect` reads transcripts under
`~/.claude/projects/` and `~/.codex/sessions/` **locally only** and uploads
nothing on its own. The collected trace contains **only content hashes, file
paths, timestamps, and the model** — never prompt or response text. It prints a
disclosure (which directories it reads, that it's local-only, how many sessions
matched) before writing anything. Run `vibetrace collect` alone to preview, then
add `--yes` to write `.vibetrace/collected-trace.json`. Opt into truncated text
excerpts with `--include-excerpts` (off by default). Only files that actually
exist in the repo now are attributed, mutating file tools are recorded as
produced artifacts, and prompt/response hashes are real sha256 over the session
text.

The registry URL comes from `VIBETRACE_REGISTRY_URL` or
`vibetrace.config.json` under `publish.registryUrl` (default
`http://localhost:5173`). If the registry is unreachable, `vibetrace` still
publishes locally and prints a clear note instead of crashing.

Work on VibeTrace itself:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Add VibeTrace to an existing project:

```bash
# from the project you want to trace
pnpm add -D vibetrace-cli
pnpm exec vibetrace init --ci
```

`init --ci` creates:

- `vibetrace.config.json` — shareable project config.
- `.vibetrace/` — private local ledger workspace.
- `.gitignore` entry for `.vibetrace/`.
- `.github/workflows/vibetrace.yml` — a one-command CI job.

Commit the config, workflow, and `.gitignore` update. Contributors do not need
to run VibeTrace commands locally. The CI job runs:

```bash
pnpm exec vibetrace ci
```

`vibetrace ci` initializes if needed, snapshots the repo, auto-discovers trace
JSON, verifies the ledger, and exports `public/vibetrace.json`.

During local development from this monorepo, run the CLI through pnpm:

```bash
pnpm --filter @vibetrace/cli vibetrace init --ci
pnpm --filter @vibetrace/cli vibetrace ci
```

Open the dashboard locally:

```bash
pnpm dev:viewer
```

Then visit `http://localhost:5173/?bundle=<url-to-public-vibetrace.json>`, or
open `http://localhost:5173/` for the landing page and leaderboard links.

For a deployed board, run the viewer server from `apps/viewer` and point repo
owners at it with environment variables:

```bash
VIBETRACE_REGISTRY_URL=https://your-vibetrace-viewer.example
VIBETRACE_VIEWER_URL=https://your-vibetrace-viewer.example
```

**You fund nothing.** By default, `npx vibetrace-cli` delegates every funded 0G write
— the chain anchor, the 0G Storage upload, and the TEE-attested 0G Compute
judgment — to a hosted **VibeTrace relayer** that holds the funded 0G key. The
`vibetrace` client never holds a key and you never pay gas: point it at a relayer
and run one command.

```bash
VIBETRACE_RELAYER_URL=https://your-relayer.example   # relayer funds anchor + storage + compute
VIBETRACE_RELAYER_AUTH_TOKEN=...                      # optional bearer auth
```

Honest framing: a hosted run is **anchored by the VibeTrace relayer** on your
behalf — the on-chain tx is sent from the relayer's wallet and commits *your*
bundle's manifest hash as calldata. It proves the relayer published your bundle
hash at that block; it does **not** imply you owned the wallet or paid. The client
re-verifies every returned receipt (the anchored hash must equal your bundle's
hash, and the on-chain + 0G Storage read-backs must match) before trusting it.

With **no relayer** configured, `npx vibetrace-cli` falls back to free, local
development anchors under `.vibetrace/` — no key, no network. To **self-host** the
funded writes instead (anchor with your OWN key rather than via a relayer), set
`VIBETRACE_OG_MODE=real-chain` (chain only) or `real` (chain + 0G Storage) and
provide your own funded key (`VIBETRACE_0G_PUBLISH_PRIVATE_KEY`, or the legacy
`VIBETRACE_0G_PRIVATE_KEY`):

```bash
VIBETRACE_OG_MODE=real
VIBETRACE_0G_PUBLISH_PRIVATE_KEY=...
VIBETRACE_0G_RPC_URL=...
```

If no relayer is configured (or it is unreachable/unverifiable), `verify`
degrades honestly to the structural-only local verifier — it never fabricates an
attestation.

`VIBETRACE_0G_STORAGE_INDEXER` is optional; the CLI uses the 0G testnet storage
indexer by default. Storage publish waits for accepted upload by default; set
`VIBETRACE_0G_STORAGE_FINALITY=true` only when you want to wait for storage-node
finality during publishing.

Check publish readiness with:

```bash
pnpm exec vibetrace doctor --json
```

## Repo map

This is a pnpm monorepo (`apps/*` + `packages/*`).

| Path | What lives there |
| --- | --- |
| `apps/cli` | The `vibetrace` CLI — `collect`, `snapshot`, `import`, `verify`, `publish`, `ci`, `doctor`, `inspect`, and the bare one-shot `ship` flow. |
| `apps/viewer` | Leaderboard + build-story dashboard, the registry server, and the embeddable build-score badge SVG. |
| `packages/schema` | Zod schemas and ledger/graph types (trace spans, claims, artifact graph, manifest). |
| `packages/graph` | Builds the artifact/build graph from traces, snapshots, and claims. |
| `packages/score` | Computes the build score (`VibeScore`) from a public bundle. |
| `packages/verifier` | Local structural verifier, attested adjudicator, and relayer client. |
| `packages/og` | 0G adapters — Storage and Chain anchoring (dev + real, env-driven). |
| `scripts/` | Adjudication relayer and build/bundle scripts. |
| `examples/` | Config and GitHub Actions templates. |

## Generic Trace Format

CI mode auto-discovers trace files from `.agenttrace/`, `.vibetrace/inbox/`,
`agenttrace/`, `ai-traces/`, `traces/`, `trace.json`, and
`vibetrace.trace.json`.

```json
[
  {
    "spanId": "span-1",
    "tool": "codex",
    "model": "gpt-5",
    "startedAt": "2026-06-17T10:00:00.000Z",
    "endedAt": "2026-06-17T10:03:00.000Z",
    "promptHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "responseHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "filesMentioned": ["src/index.ts"],
    "artifactsProduced": ["src/index.ts"],
    "metadata": {}
  }
]
```

Raw prompts are not part of the public bundle by default. Optional excerpts are
accepted locally and redacted before publishing.

## Integration Files

- [docs/integration.md](docs/integration.md) — project owner integration guide.
- [examples/vibetrace.config.json](examples/vibetrace.config.json) — config template.
- [examples/github-action.yml](examples/github-action.yml) — CI template.
