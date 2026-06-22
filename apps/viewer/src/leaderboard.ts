import type { RegistrySummary } from "./registry";
import { escapeHtml, renderLiveMarquee, relativeTimeFromIso, tierBadgeClass, sealLabel } from "./viewer";
import { renderNav } from "./landing";
import { renderFooter } from "./footer";

/* ── Tool·model badges from the summary's distinct tool·model pairs ── */

function toolModelBadges(entry: RegistrySummary): string {
  // Group models under each tool so a tool chip is never repeated (e.g. claude-code
  // shows once with both opus + sonnet, instead of two "claude-code" pills).
  const toolToModels = new Map<string, string[]>();
  for (const pair of entry.tools) {
    const tool = String(pair.tool ?? "tool");
    const model = String(pair.model ?? "model");
    if (!toolToModels.has(tool)) toolToModels.set(tool, []);
    const models = toolToModels.get(tool)!;
    if (!models.includes(model)) models.push(model);
  }
  const badges = [...toolToModels.entries()].map(([tool, models]) => {
    const modelSegs = models
      .map((m) => `<span class="bg-lime text-ink px-1.5 py-0.5 border-l-2 border-ink">${escapeHtml(m)}</span>`)
      .join("");
    return (
      `<span class="inline-flex items-center b2 hard font-mono text-[10px] sm:text-[11px] font-bold whitespace-nowrap">` +
      `<span class="bg-blue text-white px-1.5 py-0.5">${escapeHtml(tool)}</span>` +
      modelSegs +
      `</span>`
    );
  });
  return badges.length
    ? `<div class="flex flex-wrap gap-1.5">${badges.join("")}</div>`
    : `<span class="font-mono text-[11px] text-ink/50">no public spans</span>`;
}

/** Placeholder "open rank" row shown when the board is sparse — makes it read as a
 *  leaderboard with room to climb, not an empty/dead page. */
function renderGhostRow(rank: number): string {
  return `
    <div class="b3 border-dashed border-ink/30 bg-paper/40 p-4 sm:p-5 flex items-center gap-3 sm:gap-5" aria-hidden="true">
      <div class="b2 border-dashed border-ink/40 text-ink/40 w-12 h-12 sm:w-14 sm:h-14 grid place-items-center shrink-0 font-display text-xl sm:text-2xl">${rank}</div>
      <div class="font-mono text-xs sm:text-sm text-ink/45">Open rank — run <code class="bg-ink text-lime px-1 font-bold">npx vibetrace-cli</code> in your repo to claim it.</div>
    </div>`;
}

/** Proof-status pill — the TRUST dimension (anchor + verifier), shown separately
 *  from the build score. Colored by proof strength (rank), not the build grade. */
function proofPill(entry: RegistrySummary): string {
  const label = entry.proofLabel ?? sealLabel(entry.seal);
  const rank = entry.proofRank ?? 0;
  const cls =
    rank >= 5 ? "bg-lime text-ink" : rank >= 3 ? "bg-sun text-ink" : rank >= 1 ? "bg-paper text-ink" : "bg-coral text-ink";
  return `<span class="inline-flex items-center gap-1 b2 ${cls} px-2 py-0.5 hard font-mono text-[10px] font-bold uppercase tracking-wide whitespace-nowrap">${escapeHtml(
    label
  )}</span>`;
}

/* ── 0G TEE-execution pill ──
 *
 * A compact wax "◆ 0G·TEE" mark for rows whose build was independently EXAMINED
 * by an attested 0G TEE enclave (execution attested by the provider's 0G TEE
 * signer named by the attestation; verdict relayed by the operator). Fail-closed: a
 * broken seal never shows the pill, even if teeVerified was derived true. Legacy /
 * non-attested rows (teeVerified false/absent) render NOTHING. The title is
 * deliberately NON-absolute — it points viewers to the story page to inspect the
 * signer + receipt, never claiming the verdict itself was signed. */
function teePill(entry: RegistrySummary): string {
  if (entry.teeVerified !== true || entry.seal === "broken") return "";
  return (
    `<span class="tee-pill" ` +
    `title="0G TEE execution attestation present — open the story to inspect the signer and receipt.">` +
    `<span aria-hidden="true">◆</span> 0G·TEE</span>`
  );
}

/* ── One leaderboard row ── */

function renderRow(entry: RegistrySummary, rank: number): string {
  const buildTier = String(entry.buildTier ?? entry.tier);
  const tierCls = tierBadgeClass(buildTier);
  const project = escapeHtml(entry.project);
  const repo = escapeHtml(entry.repo);
  const id = escapeHtml(entry.id);
  const tier = escapeHtml(buildTier);
  const vibe = escapeHtml(String(entry.buildScore ?? entry.vibeScore));
  const rel = escapeHtml(relativeTimeFromIso(entry.submittedAt));
  const rotate = rank % 2 === 0 ? "-rotate-1" : "rotate-1";

  return `
    <a href="#/p/${id}"
       class="group block b4 bg-white hard-lg lift-lg p-4 sm:p-5"
       aria-label="${project} — VibeScore ${vibe}, tier ${tier}. Open build story.">
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-5">
        <div class="b3 bg-ink text-lime ${rotate} hard w-12 h-12 sm:w-14 sm:h-14 grid place-items-center shrink-0">
          <span class="font-display text-xl sm:text-2xl leading-none">${rank}</span>
        </div>

        <div class="min-w-0">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 class="font-display text-lg sm:text-2xl tracking-tight leading-none truncate">${project}</h3>
            <code class="font-mono text-[11px] sm:text-xs font-bold text-blue truncate">${repo}</code>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${toolModelBadges(entry)}
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${proofPill(entry)}
            ${teePill(entry)}
            <span class="font-mono text-[10px] sm:text-[11px] font-bold text-ink/50 uppercase tracking-wide">${rel}</span>
          </div>
        </div>

        <div class="flex items-center gap-2 sm:gap-4 shrink-0">
          <div class="text-right leading-none">
            <div class="font-mono text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-ink/40 mb-1">Build</div>
            <div class="font-display tag text-3xl sm:text-5xl leading-none [text-shadow:2px_2px_0_#0B0B0F]">${vibe}</div>
          </div>
          <div class="b4 ${tierCls} hard grid place-items-center w-12 h-12 sm:w-16 sm:h-16 -rotate-3 shrink-0">
            <span class="font-display text-2xl sm:text-4xl leading-none">${tier}</span>
          </div>
          <svg viewBox="0 0 24 24" class="hidden sm:block w-6 h-6 shrink-0 transition-transform group-hover:translate-x-1" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
      </div>
    </a>`;
}

/* ── Header / hook ── */

function renderHeader(count: number): string {
  const countLabel =
    count === 0
      ? "open ledger · be the first"
      : count === 1
        ? "1 project so far · run npx vibetrace-cli"
        : `${escapeHtml(String(count))} projects ranked · live`;

  return `
    <header class="mb-7">
      <div class="inline-block b3 bg-violet text-white px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-4 -rotate-1">
        ${countLabel}
      </div>
      <h1 class="font-display text-4xl sm:text-6xl lg:text-7xl leading-[0.9] tracking-tight" style="text-shadow:3px 3px 0 #0B0B0F">
        The Vibecoded<br/><span class="bg-coral text-white px-2 inline-block -rotate-1">Leaderboard</span>
      </h1>
      <p class="font-mono text-sm text-ink/60 mt-4 max-w-xl">
        AI-built software you can actually check, ranked by VibeScore. Every entry is hashed; each build story labels whether its anchor is dev, pending, or on 0G.
      </p>
    </header>`;
}

/* ── Get on the board callout ──
 *
 * There is NO manual submission form: builds are ingested ONLY from the CLI.
 * This callout shows the single `npx vibetrace-cli` command with a Copy button.
 * The Copy button reuses the [data-copy-badge] hook pattern from the story
 * page, so main.ts can bind it with the same bindCopyBadge() handler.
 */

const VIBETRACE_CMD = "npx vibetrace-cli";

function renderGetOnBoard(): string {
  const cmd = escapeHtml(VIBETRACE_CMD);
  return `
    <section aria-labelledby="board-h" class="b4 bg-violet text-white hard-xl p-4 sm:p-6 mb-8 relative overflow-hidden">
      <div class="absolute -top-6 -right-6 w-24 h-24 bg-lime b3 rotate-12 hidden sm:block" aria-hidden="true"></div>
      <div class="relative">
        <div class="flex items-center gap-3 mb-4">
          <span class="b3 bg-lime text-ink hard w-9 h-9 grid place-items-center shrink-0 -rotate-3" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="#0B0B0F" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
          </span>
          <h2 id="board-h" class="font-display text-xl sm:text-2xl tracking-tight leading-none">Get on the board</h2>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 sm:items-stretch">
          <pre class="b3 bg-ink text-lime hard p-3 font-mono text-sm sm:text-base font-bold overflow-x-auto grow min-w-0"><code data-cmd>$ ${cmd}</code></pre>
          <button type="button" data-copy-badge data-copy-text="${cmd}"
            class="b3 bg-sun text-ink hard lift inline-flex items-center justify-center gap-2 px-4 py-2.5 font-display text-sm uppercase tracking-tight shrink-0 whitespace-nowrap">
            <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span data-copy-label>Copy</span>
          </button>
        </div>

        <p class="font-mono text-[11px] sm:text-xs text-white/70 mt-3 max-w-2xl">
          No forms. Run <code class="bg-ink text-lime px-1 font-bold">npx vibetrace-cli</code> in your repo; it reads your actual AI build trace and signs it up right here.
        </p>
      </div>
    </section>`;
}

/* ── Empty / sparse board state ── */

function renderEmptyBoard(): string {
  return `
    <section aria-label="No submissions yet" class="b4 border-dashed bg-paper hard-lg p-8 text-center">
      <div class="font-display text-2xl sm:text-3xl tracking-tight mb-2">No builds on the board yet.</div>
      <p class="font-mono text-sm text-ink/60 max-w-md mx-auto">Board's empty. Run <code class="bg-ink text-lime px-1 font-bold">npx vibetrace-cli</code> in your repo and take rank one.</p>
    </section>`;
}

/* ── Main export ── */

export function renderLeaderboard(entries: RegistrySummary[]): string {
  // Match the API order (sortedSummaries): intrinsic buildScore, tie-break proof.
  const ranked = [...entries].sort(
    (a, b) =>
      (b.buildScore ?? b.vibeScore) - (a.buildScore ?? a.vibeScore) ||
      (b.proofRank ?? 0) - (a.proofRank ?? 0) ||
      b.vibeScore - a.vibeScore
  );
  // Sparse-state: pad a near-empty board with dashed "open rank" rows so it reads
  // as a leaderboard with room to climb rather than a dead page.
  const GHOST_TARGET = 5;
  const ghostCount = ranked.length > 0 && ranked.length < GHOST_TARGET ? GHOST_TARGET - ranked.length : 0;
  const ghosts = Array.from({ length: ghostCount }, (_, i) => renderGhostRow(ranked.length + i + 1)).join("");
  const board =
    ranked.length === 0
      ? renderEmptyBoard()
      : `<section aria-label="Leaderboard" class="grid gap-4">${ranked.map((e, i) => renderRow(e, i + 1)).join("")}${ghosts}</section>`;

  return `
    ${renderNav("leaderboard")}
    ${renderLiveMarquee(entries)}
    <main class="grow w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
      ${renderHeader(ranked.length)}
      ${renderGetOnBoard()}
      ${board}
    </main>
    ${renderFooter()}`;
}
