# @vibetrace/cli

Local-first **proof-of-build** ledger for AI-assisted software.

```bash
npx @vibetrace/cli          # run it in any repo
# or install the `vibetrace` command globally:
npm i -g @vibetrace/cli && vibetrace
```

Run it in any repo. It reads your *local* AI-agent build transcripts
(Claude Code `~/.claude`, Codex `~/.codex`) for sessions that ran in **this**
repo, hashes the work (file paths, prompt/response hashes, timestamps, model —
never prompt/response text), snapshots the tree, and publishes an inspectable
**public build story** — with a build score — to the leaderboard.

Privacy: prompt/response text is not uploaded. Registry registration posts the
redacted public bundle; use `--no-register` to skip that POST. In live 0G modes,
publish can still anchor/upload the public bundle to 0G before registry
registration. Use `--registry-url <url>` / `VIBETRACE_REGISTRY_URL` to point at
your own. Use `VIBETRACE_VIEWER_URL` to print shareable viewer links for a
deployed board.

Real on-chain anchoring on 0G is opt-in via `VIBETRACE_OG_MODE=real-chain`.
Set `VIBETRACE_OG_MODE=real` when you also want 0G Storage upload
(`VIBETRACE_0G_PRIVATE_KEY` + `VIBETRACE_0G_RPC_URL`).

For an independent, **TEE-attested 0G Compute** verdict, the judgment leg runs on
a hosted adjudication relayer that holds the funded compute key — this client
never sees it. Point the client at one with `VIBETRACE_RELAYER_URL`. If no
relayer is set (or it is unreachable/unverifiable), `vibetrace` degrades
honestly to the local structural verifier and never fabricates an attestation.
