# VibeTrace — Demo Script (for the 0G community)

A ~5-minute live demo. Three acts: **the problem → one command → check it yourself.**
Talking points are in plain text; commands are in code blocks; honest caveats are flagged so you never get caught overclaiming on stage.

---

## Cold open (~45s) — say this

> "Everyone says they 'vibe-coded' their project. Nobody can prove it.
> AI-built software has no provenance — no way to tell a real agent-built repo
> from someone who pasted a README.
>
> VibeTrace is a **proof-of-build ledger** for AI-assisted software. It traces
> your *real* agent sessions, anchors the fingerprint on **0G**, and lets an
> attested **0G TEE** examiner independently judge whether the work backs the
> claim. The output is one thing a builder can show:
> **'Yes, I vibe-coded this. Receipts attached.'**"

One line on *why 0G specifically*:

> "This isn't 0G-flavored. It uses all three 0G pillars for what each is actually
> for — **0G Storage** holds the bundle, **0G Chain** anchors its hash, and
> **0G Compute (TeeML)** runs the neutral examiner in a TEE. The verdict is only
> trustworthy *because* a third party can't quietly rewrite it."

---

## Act 1 — The board (~60s)

Start with the viewer already running and the seeded entry visible.

```bash
pnpm dev:viewer          # http://localhost:5173
```

Talking points:
- Open the leaderboard. "This is a real self-trace of VibeTrace building itself."
- Click into the entry → the **Receipts Attached** card.
- Point at three things on the card:
  - **`ANCHORED ON 0G`** — the build's fingerprint is on 0G Chain + 0G Storage.
  - The **tier** (`S — Fully AI-Traced`) and **Build Score**.
  - The per-claim **evidence badges**: `claim-ai-build` → *verified, 1923 public
    artifacts support this claim*; the two 0G claims → honestly **unsupported**.

> "Notice it does NOT pretend the 0G claims are proven. The examiner only stamps
> what the public evidence backs. A tool that can't say 'no' is worthless —
> ours says no on stage."

---

## Act 2 — One command (~90s)

Run the whole flow live on a small repo (lowest-risk path: local fallback, no key, no gas, can't fail).

```bash
cd /path/to/a/small/repo-you-built-with-an-agent
npx vibetrace-cli
```

Narrate while it runs — it does five things in one shot:
1. **collect** — reads your real Claude Code / Codex traces from `~/.claude` and
   `~/.codex`, *locally only*. "It uploads nothing. The trace is just content
   hashes, file paths, timestamps, and the model name — never your prompts."
2. **snapshot** — hashes the repo's current file/Git state.
3. **verify** — re-runs deterministic checks and stamps evidence badges.
4. **publish** — writes a redacted public bundle.
5. **register** — puts you on the board.

End state:

```
✓ You're on the board: http://localhost:5173/#/p/<id>
```

Refresh the viewer → the new entry is there. (Restart the viewer if it doesn't
appear — the registry seeds at boot.)

> "From inside any repo, one command, zero config, zero keys. That's the whole
> onboarding."

---

## Act 3 — Check it yourself (~60s) — the money shot

This is the line that separates VibeTrace from a screenshot.

```bash
npx vibetrace-cli verify .vibetrace/public/<bundle>.json
```

Use the pre-anchored seeded bundle here so all three legs are live. It
re-fetches the **0G Storage** object, reads the **0G Chain** calldata, and checks
the **TEE signer** — independently of anything on screen.

```
storage matches · chain matches · SIGNER MATCHES
```

> "Don't trust the badge — re-verify it. It pulls the bundle back from 0G
> Storage, reads the hash off 0G Chain, and recovers the TEE signer. If I'd
> faked anything, this fails. *That's* the receipt."

---

## What it brings to the 0G community — closing slide

- **A flagship dev-tool that exercises all three 0G pillars** end-to-end —
  Storage, Chain, and Compute/TEE — for their real purpose, not as a checkbox.
- **An onboarding funnel.** Every builder who runs `npx vibetrace-cli` writes to
  0G on their first run, with **no wallet and no gas** (the hosted relayer funds
  the writes). Lowest-friction "your first 0G transaction" in the ecosystem.
- **A real use case for 0G Compute/TeeML:** a neutral, attested adjudicator —
  the canonical "trust-minimized AI verdict" pattern other teams can copy.
- **A culture artifact.** "Receipts attached" gives the 0G builder community a
  shareable, verifiable badge of honor — provenance as social proof.
- **Open and local-first.** MIT, no lock-in, runs fully offline in dev mode;
  0G is the trust layer you opt into, not a dependency you're trapped in.

---

## Honest caveats — keep these straight so you don't get caught

- **The verdict is trusted-transport, not a signed verdict.** 0G TeeML signs
  `responseHash:chatID` — it attests the examiner *executed in the enclave*, not
  the verdict JSON's contents. Correct phrasing: *"examined by an attested 0G TEE
  (execution attested); verdict relayed."* Never say "0G signed the verdict."
- **"Anchored by the relayer."** In hosted mode the on-chain tx comes from the
  relayer's wallet committing *your* bundle hash. It proves the hash was
  published at that block — not that you owned the wallet or paid. The client
  re-verifies the anchored hash equals your bundle's hash.
- **Self-attested vs independently examined are shown separately.** A self-check
  never wears the "independently examined" badge. Say that out loud — the honesty
  is the product.

---

## Pre-demo checklist

- [ ] Viewer running (`pnpm dev:viewer`) with the seeded attested entry visible.
- [ ] A small target repo ready that has real local agent traces (the weak 7B
      examiner needs a small graph; keep the live attested leg to a small repo).
- [ ] `pnpm test && pnpm typecheck` green (have it ready as a backup credibility shot).
- [ ] **If demoing the live attested leg:** relayer running (`pnpm relayer`),
      funded (~2 OG: ~1 free + 1 locked in the provider sub-account),
      `VIBETRACE_OG_MODE=real`, `VIBETRACE_0G_STORAGE_FINALITY=true`. The
      provider rate-limits at 2000 tok/min, so set `VIBETRACE_ADJUDICATION_TABLE_CAP`
      low (~48) and run on a fresh budget.
- [ ] **Safer default:** lean on the *pre-seeded* entry for the attested story,
      and do the *live run* in local fallback mode — it cannot fail on stage.
```
