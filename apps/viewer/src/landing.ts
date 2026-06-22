import type { RegistrySummary } from "./registry";
import { escapeHtml, tierBadgeClass, relativeTimeFromIso } from "./viewer";
import { logoMark, heroSeal, og0gGlitch } from "./assets";
import { renderFooter } from "./footer";

/* ── Shared top nav (used on every page) ── */

/**
 * Consistent Neo-Brutal top nav: VibeTrace wordmark links home (#/), plus a
 * Leaderboard link. `active` highlights the current section.
 */
export function renderNav(active: "landing" | "leaderboard" | "story" = "landing"): string {
  const leaderboardActive = active === "leaderboard";
  return `
    <nav class="sticky top-0 z-30 bg-paper/95 backdrop-blur b4 border-t-0 border-x-0" aria-label="Primary">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3">
        <a href="#/" class="flex items-center gap-2.5 group" aria-label="VibeTrace home">
          <span class="b3 bg-lime hard w-9 h-9 grid place-items-center shrink-0 transition-transform group-hover:-rotate-6" aria-hidden="true">
            ${logoMark(22, { tileFill: "transparent" })}
          </span>
          <span class="font-display text-lg sm:text-xl tracking-tight leading-none">VibeTrace</span>
        </a>
        <a href="#/leaderboard"
           class="b3 hard lift px-3 py-1.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-wide ${
             leaderboardActive ? "bg-ink text-lime" : "bg-sun text-ink"
           }">
          Leaderboard →
        </a>
      </div>
    </nav>`;
}

/* ── Hero ── */

function renderHero(): string {
  return `
    <section class="relative pt-10 sm:pt-16 pb-8 overflow-hidden" aria-labelledby="hero-h">
      <!-- Decorative blocks: pinned to safe margins, BEHIND content (z-0). They
           never overlap the headline — the violet sits top-right past the text
           column, the blue bottom-left below the CTAs, both clipped by overflow. -->
      <div class="absolute top-2 -right-10 w-24 h-24 bg-violet b3 rotate-12 hidden xl:block z-0 pointer-events-none" aria-hidden="true"></div>
      <div class="absolute -bottom-10 -left-10 w-20 h-20 bg-blue b3 -rotate-6 hidden lg:block z-0 pointer-events-none" aria-hidden="true"></div>

      <div class="relative z-10 grid lg:grid-cols-[1.25fr_1fr] gap-8 lg:gap-10 items-center">
        <div>
          <div class="inline-flex items-center gap-2 b3 bg-violet text-white px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-6 -rotate-1">
            <span class="w-2 h-2 bg-lime b2 inline-block" aria-hidden="true"></span>
            Local-first proof-of-build ledger
          </div>

          <h1 id="hero-h" class="font-display text-5xl sm:text-7xl lg:text-7xl xl:text-8xl leading-[0.88] tracking-tight" style="text-shadow:4px 4px 0 #0B0B0F">
            Prove your software<br/>was <span class="bg-coral text-white px-2 inline-block -rotate-1">built with AI.</span>
          </h1>

          <p class="font-mono text-sm sm:text-base text-ink/70 mt-6 max-w-2xl leading-relaxed">
            VibeTrace reads how your code got made — the AI traces, the files, the commits — and reports
            <span class="bg-ink text-lime px-1 font-bold">two honest signals</span>: a
            <span class="font-bold text-ink">Build Score</span> for how AI-built it is, and
            <span class="font-bold text-ink">Proof</span> for how independently that's been examined. The default
            <span class="font-mono text-ink">npx vibetrace</span> run writes a local dev anchor; in opt-in real mode it
            anchors the fingerprint to ${og0gGlitch()}. It never fakes a check it didn't run. Change one byte and it
            stops matching — so nobody has to take your word for it.
          </p>

          <div class="mt-8 flex flex-wrap items-center gap-3">
            <a href="#/leaderboard"
               class="b4 bg-lime hard-lg lift-lg inline-flex items-center gap-2 px-5 py-3 font-display text-base sm:text-lg uppercase tracking-tight">
              See the leaderboard
              <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </a>
            <a href="#integrate"
               class="b4 bg-white hard-lg lift-lg inline-flex items-center gap-2 px-5 py-3 font-display text-base sm:text-lg uppercase tracking-tight">
              Add to your project
              <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
            </a>
          </div>
        </div>

        <!-- Hero proof-seal visual: hidden on small screens (text leads on 390px),
             shown from lg up so the headline always has room. -->
        <div class="hidden lg:block" aria-hidden="false">
          ${heroSeal()}
        </div>
      </div>
    </section>`;
}

/* ── How it works (5 beats) ── */

function renderHowItWorks(): string {
  const beats = [
    {
      num: "①",
      title: "Capture",
      body: "Snapshot your repo and pull in the AI trace spans from your coding tools. Prompts and responses get hashed, not published — the content stays yours.",
      bg: "bg-violet text-white",
      numBg: "bg-lime text-ink"
    },
    {
      num: "②",
      title: "Link",
      body: "Wire it into a lineage graph: trace spans → files → commits. Every output points back to the work that produced it.",
      bg: "bg-white text-ink",
      numBg: "bg-coral text-white"
    },
    {
      num: "③",
      title: "Verify",
      body: "A deterministic verifier re-runs the checks and stamps an evidence badge on each claim. Self-attested by default — whether anyone independent signed it is shown separately, so a self-check never poses as one.",
      bg: "bg-blue text-white",
      numBg: "bg-sun text-ink"
    },
    {
      num: "④",
      title: "Anchor",
      body: "Opt into real mode and the bundle fingerprint goes on 0G; by default npx vibetrace writes a local dev anchor instead. Either way, tamper with anything afterward and the hash no longer lines up. Anyone can run that check.",
      bg: "bg-sun text-ink",
      numBg: "bg-ink text-lime"
    },
    {
      num: "⑤",
      title: "Score & publish",
      body: "You get a Build Score + Proof status, a public build-story page, and an SVG badge you can drop in a README. One npx vibetrace run lands you on the leaderboard.",
      bg: "bg-ink text-paper",
      numBg: "bg-lime text-ink"
    }
  ];

  const cards = beats
    .map(
      (b, i) => `
      <article class="vt-how-step b4 ${b.bg} hard-lg p-5 flex flex-col gap-3" data-how-step="${i}">
        <div class="vt-how-badge shrink-0 b3 ${b.numBg} w-11 h-11 grid place-items-center hard font-display text-2xl leading-none" data-how-badge="${i}">${b.num}</div>
        <h3 class="font-display text-xl tracking-tight leading-snug">${b.title}</h3>
        <p class="font-mono text-xs sm:text-sm leading-relaxed opacity-80">${b.body}</p>
      </article>`
    )
    .join("");

  // The timeline spine connects the step badges and DRAWS IN on scroll (its
  // scaleX/scaleY animate from 0; transform-origin is the start). It's purely
  // decorative — aria-hidden — and starts already-drawn under reduced motion.
  return `
    <section aria-labelledby="how-h" class="py-10 sm:py-14">
      <div class="flex items-center gap-3 mb-6">
        <h2 id="how-h" class="font-display text-3xl sm:text-4xl tracking-tight">How it works</h2>
        <span class="b3 bg-paper hard px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest -rotate-2">5 steps</span>
      </div>
      <div class="vt-how-rail relative">
        <!-- timeline spine: a bold ink rail behind the cards, drawn capture→publish -->
        <div class="vt-how-spine absolute left-0 right-0 top-[34px] h-1 bg-ink/70 rounded-full origin-left pointer-events-none hidden lg:block" aria-hidden="true"></div>
        <div class="relative grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
          ${cards}
        </div>
      </div>
    </section>`;
}

/* ── The VibeScore explainer + tier ladder ── */

function renderVibeScore(): string {
  const tiers = [
    { tier: "S", label: "Fully AI-Traced", bg: "bg-lime text-ink" },
    { tier: "A", label: "Heavily AI-Built", bg: "bg-lime text-ink" },
    { tier: "B", label: "Substantially AI-Built", bg: "bg-blue text-white" },
    { tier: "C", label: "Partially AI-Built", bg: "bg-sun text-ink" },
    { tier: "D", label: "Lightly AI-Touched", bg: "bg-coral text-ink" }
  ];

  const ladder = tiers
    .map(
      (t) => `
      <li class="flex items-center gap-3 b3 bg-white hard p-2.5">
        <span class="b3 ${t.bg} hard w-11 h-11 grid place-items-center shrink-0 -rotate-3">
          <span class="font-display text-2xl leading-none">${escapeHtml(t.tier)}</span>
        </span>
        <span class="font-mono text-xs sm:text-sm font-bold">${escapeHtml(t.label)}</span>
      </li>`
    )
    .join("");

  return `
    <section aria-labelledby="score-h" class="py-10 sm:py-14">
      <div class="grid lg:grid-cols-[1fr_auto] gap-7 items-start">
        <div class="b4 bg-white hard-xl p-5 sm:p-7">
          <div class="inline-block b3 bg-coral text-white px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-4 -rotate-1">The VibeScore</div>
          <h2 id="score-h" class="font-display text-3xl sm:text-4xl tracking-tight mb-3">Two signals, never one blurred number.</h2>
          <p class="font-mono text-sm text-ink/70 leading-relaxed mb-3">
            <span class="bg-ink text-lime px-1.5 font-bold">Build Score</span> measures how much of the repo is AI-traced —
            artifact coverage, verified claims, trace depth. It's intrinsic to the build and re-derivable anywhere; it does
            <span class="font-bold text-ink">not</span> change based on who notarized it.
          </p>
          <p class="font-mono text-sm text-ink/70 leading-relaxed mb-3">
            <span class="bg-violet text-white px-1.5 font-bold">Proof</span> sits right beside it, separately: whether the
            fingerprint is anchored on 0G, and whether an independent examiner ran the build in an attested TEE — self-attested vs
            independently examined.
          </p>
          <p class="font-mono text-xs text-ink/50 leading-relaxed">
            So a repo's grade reflects the build, and trust is labeled honestly next to it — never one multiplied into the
            other. Self-attested work shows up on the board; it just can't wear a badge it didn't earn.
          </p>
        </div>

        <div class="lg:w-72">
          <div class="font-mono text-[11px] font-bold uppercase tracking-widest text-blue mb-3">Build tiers · S → D</div>
          <ul class="grid gap-2.5">
            ${ladder}
          </ul>
        </div>
      </div>
    </section>`;
}

/* ── Proof in the wild — top-3 peek of the real leaderboard ── */

function peekRow(entry: RegistrySummary, rank: number): string {
  const buildTier = String(entry.buildTier ?? entry.tier);
  const tierCls = tierBadgeClass(buildTier);
  const project = escapeHtml(entry.project);
  const repo = escapeHtml(entry.repo);
  const id = escapeHtml(entry.id);
  const tier = escapeHtml(buildTier);
  const vibe = escapeHtml(String(entry.buildScore ?? entry.vibeScore));
  const rel = escapeHtml(relativeTimeFromIso(entry.submittedAt));

  return `
    <a href="#/p/${id}" class="group block b3 bg-white hard lift p-3.5">
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <div class="b3 bg-ink text-lime hard w-10 h-10 grid place-items-center shrink-0 -rotate-2">
          <span class="font-display text-lg leading-none">${rank}</span>
        </div>
        <div class="min-w-0">
          <div class="font-display text-base sm:text-lg tracking-tight truncate leading-none">${project}</div>
          <code class="font-mono text-[11px] font-bold text-blue truncate block mt-1">${repo}</code>
          <span class="font-mono text-[10px] font-bold text-ink/40 uppercase tracking-wide">${rel}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="font-display tag text-2xl sm:text-3xl leading-none [text-shadow:2px_2px_0_#0B0B0F]">${vibe}</div>
          <span class="b3 ${tierCls} hard w-9 h-9 grid place-items-center -rotate-3">
            <span class="font-display text-xl leading-none">${tier}</span>
          </span>
        </div>
      </div>
    </a>`;
}

function renderProofInTheWild(entries: RegistrySummary[]): string {
  const ranked = [...entries].sort((a, b) => (b.buildScore ?? b.vibeScore) - (a.buildScore ?? a.vibeScore));
  const top = ranked.slice(0, 3);

  // Graceful sparse handling: always show what exists, then an inviting next-slot.
  const rows = top.map((e, i) => peekRow(e, i + 1)).join("");

  // Invitation slot — shown whenever fewer than 3 real entries exist.
  const inviteSlot =
    top.length < 3
      ? `
      <a href="#/leaderboard" class="group block b3 border-dashed bg-paper hard lift p-3.5">
        <div class="flex items-center gap-3">
          <div class="b3 border-dashed w-10 h-10 grid place-items-center shrink-0 text-ink/40">
            <svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </div>
          <div class="min-w-0">
            <div class="font-display text-base sm:text-lg tracking-tight leading-none">Be the next.</div>
            <span class="font-mono text-[11px] font-bold text-ink/50">Run npx vibetrace and grab a rank →</span>
          </div>
        </div>
      </a>`
      : "";

  const countLabel =
    ranked.length === 0
      ? "Nothing on the ledger yet. It's wide open."
      : ranked.length === 1
        ? "One build so far. Yours could be number two."
        : `${escapeHtml(String(ranked.length))} builds ranked, more landing.`;

  return `
    <section aria-labelledby="wild-h" class="py-10 sm:py-14">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div class="inline-block b3 bg-blue text-white px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-3 rotate-1">Proof in the wild</div>
          <h2 id="wild-h" class="font-display text-3xl sm:text-4xl tracking-tight">Real builds, ranked.</h2>
          <p class="font-mono text-xs text-ink/50 mt-2">${countLabel}</p>
        </div>
        <a href="#/leaderboard" class="b3 bg-sun hard lift inline-flex items-center gap-1.5 px-3.5 py-2 font-mono text-xs font-bold uppercase tracking-wide shrink-0">
          See full leaderboard
          <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </a>
      </div>
      <div class="grid gap-3">
        ${rows}
        ${inviteSlot}
      </div>
    </section>`;
}

/* ── Integrate CTA — one command ──
 *
 * Leads with the single `npx vibetrace` command (collect → publish → on the
 * board). The multi-step CLI (install/init/publish) is de-emphasized to a small
 * honest footnote underneath. Builds are ingested ONLY from the CLI — there is
 * no manual "submit a URL" path.
 */

function renderIntegrate(): string {
  const oneCmd = escapeHtml("npx vibetrace");
  const multiStep = escapeHtml("pnpm add -D @vibetrace/cli  →  vibetrace init  →  vibetrace publish");
  const badgeSnippet = escapeHtml(
    "[![VibeScore](<your-vibetrace-host>/api/badge/<id>.svg)](<your-vibetrace-host>/#/p/<id>)"
  );

  return `
    <section id="integrate" aria-labelledby="integrate-h" class="py-10 sm:py-16 scroll-mt-20">
      <div class="b4 bg-violet text-white hard-xl p-5 sm:p-8">
        <div class="inline-block b3 bg-lime text-ink px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-4 -rotate-1">Add to your project</div>
        <h2 id="integrate-h" class="font-display text-3xl sm:text-5xl tracking-tight leading-[0.95] mb-3" style="text-shadow:3px 3px 0 #0B0B0F">Get on the board in one command.</h2>
        <p class="font-mono text-sm text-white/70 max-w-2xl mb-6">
          Run it in your repo. <code class="bg-ink text-lime px-1.5 font-bold">npx vibetrace</code> reads your actual AI
          build trace, publishes it, and signs you up on the leaderboard. No forms. No URL to paste.
        </p>

        <div class="b4 bg-white text-ink hard-lg p-4 sm:p-5 mb-5">
          <div class="font-mono text-[11px] font-bold uppercase tracking-widest text-ink/40 mb-2">collect → publish → on the board</div>
          <pre class="b3 bg-ink text-lime hard p-3.5 font-mono text-base sm:text-lg font-bold overflow-x-auto"><code>$ ${oneCmd}</code></pre>
          <p class="font-mono text-[11px] text-ink/50 mt-3">
            Want the steps spelled out? Same pipeline, just longhand:
            <code class="bg-paper text-ink/70 px-1 font-bold">${multiStep}</code>.
          </p>
        </div>

        <div class="b4 bg-white text-ink hard-lg p-4 sm:p-5">
          <div class="font-display text-lg tracking-tight">Then show it off →</div>
          <p class="font-mono text-xs text-ink/60 mt-1">Once you're on the board, grab the badge and paste it into your README:</p>
          <pre class="b3 bg-ink text-lime hard p-2.5 mt-2 font-mono text-[10px] sm:text-[11px] font-bold overflow-x-auto"><code>${badgeSnippet}</code></pre>
        </div>
      </div>
    </section>`;
}

/* ── Main export ── */

/**
 * The product LANDING page — a narrative story of VibeTrace (distinct from the
 * leaderboard and from a single build story). Entries come from getRegistry();
 * they feed only the small "proof in the wild" peek and are handled gracefully
 * when sparse (including zero entries — the page never looks broken/empty).
 */
export function renderLanding(entries: RegistrySummary[]): string {
  return `
    <main class="grow w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
      ${renderHero()}
      ${renderHowItWorks()}
      ${renderVibeScore()}
      ${renderProofInTheWild(entries)}
      ${renderIntegrate()}
    </main>
    ${renderFooter()}`;
}
