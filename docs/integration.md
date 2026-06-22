# Integrating VibeTrace Into An Existing Project

VibeTrace is designed to sit beside a normal repository without proxying tools
or changing the build system. It reads Git/file state, imports trace JSON, builds
a local private ledger, and exports an explicit public bundle only when asked.

## 1. Initialize Once

Install the CLI in the project you want to trace:

```bash
pnpm add -D vibetrace-cli
```

During local monorepo development, use `pnpm --filter @vibetrace/cli vibetrace`
instead of `vibetrace`.

```bash
pnpm exec vibetrace init --ci
pnpm exec vibetrace doctor
```

This creates `vibetrace.config.json`, a private `.vibetrace/` workspace, and
`.github/workflows/vibetrace.yml`. The workspace is added to `.gitignore`;
commit the config, workflow, and `.gitignore` update, not the ledger.

## 2. Configure Snapshot Ignores

Edit `vibetrace.config.json` if your repo has generated or sensitive paths:

```json
{
  "snapshot": {
    "ignore": ["fixtures/**", "secrets/**", "*.local.json"]
  }
}
```

Default ignores already exclude `.git`, `.vibetrace`, `node_modules`, build
outputs, Playwright output, `.env*`, and log files.

## 3. Let Tools Drop Trace JSON

Any tool can produce trace JSON as long as it matches the generic span format:

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

Raw prompt/response excerpts are accepted locally, but they are not published by
default.

CI mode auto-discovers traces from:

```text
.agenttrace/*.json
.vibetrace/inbox/*.json
agenttrace/*.json
ai-traces/*.json
traces/*.json
trace.json
vibetrace.trace.json
```

Nested files under those directories are also supported. Contributors do not
need to run VibeTrace commands; their trace tool only needs to write one of
these files.

## 4. Run One CI Command

```bash
pnpm exec vibetrace ci
```

`vibetrace ci` initializes if needed, snapshots the repo, imports discovered
traces, verifies lineage, exports `public/vibetrace.json`, and uses
`VIBETRACE_REGISTRY_URL` / `VIBETRACE_VIEWER_URL` when those environment
variables are present. The generated GitHub Actions workflow also uploads that
file as a CI artifact.

## 5. Check Readiness

```bash
pnpm exec vibetrace doctor --json
pnpm exec vibetrace inspect --json
```

`doctor` reports missing setup, missing live 0G environment variables in
`real-chain` / `real` mode, and the next action a repo owner should take.

Manual commands still exist for local debugging:

```bash
pnpm exec vibetrace snapshot
pnpm exec vibetrace import --file trace.json
pnpm exec vibetrace verify
pnpm exec vibetrace publish --public-summary --out public/vibetrace.json
```

## 6. Live 0G Mode

Local/dev mode is the default. For a deployed public board, set:

```bash
VIBETRACE_REGISTRY_URL=https://your-vibetrace-viewer.example
VIBETRACE_VIEWER_URL=https://your-vibetrace-viewer.example
```

For live 0G Chain only, set:

```bash
VIBETRACE_OG_MODE=real-chain
VIBETRACE_0G_PRIVATE_KEY=...
VIBETRACE_0G_RPC_URL=...
```

For live 0G Chain plus 0G Storage, set:

```bash
VIBETRACE_OG_MODE=real
VIBETRACE_0G_PRIVATE_KEY=...
VIBETRACE_0G_RPC_URL=...
```

`VIBETRACE_0G_STORAGE_INDEXER` is optional; set it only when overriding the
default 0G testnet storage indexer. Storage publish waits for accepted upload by
default; set `VIBETRACE_0G_STORAGE_FINALITY=true` when you want the slower
storage-node finality gate.

For the verifier to count as independent, **TEE-attested 0G Compute**, run a
hosted adjudication relayer (`pnpm relayer`, holding the funded
`VIBETRACE_0G_COMPUTE_PRIVATE_KEY` server-side) and point the client at it — the
client never holds the compute key:

```bash
VIBETRACE_RELAYER_URL=https://your-relayer.example
VIBETRACE_RELAYER_AUTH_TOKEN=...   # optional bearer
```

Only enable live 0G settings when the project actually needs live 0G Storage,
Chain, or Compute for the current publish path.
