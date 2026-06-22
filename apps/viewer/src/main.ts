import { PublicLedgerBundle, hashPublicLedgerBundle } from "@vibetrace/schema";
import { scoreBundle } from "@vibetrace/score";
import { renderBundle, renderLiveMarquee, escapeHtml } from "./viewer";
import { renderLeaderboard } from "./leaderboard";
import { renderLanding, renderNav } from "./landing";
import { getRegistry, getBundleEntry, type RegistrySummary } from "./registry";
import { initMotion, teardownMotion } from "./motion";
import { initModelMarks } from "./model-marks";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

let registry: RegistrySummary[] = [];
let registryLoaded = false;

/* ── Live marquee ticker ──
 * The CSS .marquee-track scroll runs uninterrupted — we NEVER replace the
 * track node or restart the animation. Liveness comes from ticking the
 * relative timestamps in place: each timestamp span in the track carries a
 * data-ts="<absoluteMillis>" attribute. Every ~5 seconds we query all
 * [data-ts] spans (both copies in the duplicated loop) and update only their
 * textContent to the recomputed relative time. Zero animation reset.
 * Honors reduced motion: we skip ticking (it doesn't animate anyway, but
 * the track is hidden under reduced motion so there's nothing to update).
 */
let marqueeTimer: ReturnType<typeof setInterval> | null = null;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function tickTimestamps(root: HTMLElement): void {
  const spans = Array.from(root.querySelectorAll<HTMLElement>("[data-ts]"));
  const now = Date.now();
  for (const span of spans) {
    const absMs = Number(span.dataset.ts);
    if (!Number.isFinite(absMs)) continue;
    const minutesAgo = Math.max(0, Math.round((now - absMs) / 60_000));
    let rel: string;
    if (minutesAgo <= 0) rel = "just now";
    else if (minutesAgo < 60) rel = `${minutesAgo}m ago`;
    else {
      const h = Math.floor(minutesAgo / 60);
      if (h < 24) rel = `${h}h ago`;
      else rel = `${Math.floor(h / 24)}d ago`;
    }
    span.textContent = rel;
  }
}

function startMarquee(root: HTMLElement): void {
  if (marqueeTimer) {
    clearInterval(marqueeTimer);
    marqueeTimer = null;
  }
  if (registry.length === 0 || prefersReducedMotion()) return;

  marqueeTimer = setInterval(() => {
    const host = root.querySelector<HTMLElement>("[data-marquee-host]");
    if (!host) {
      // Marquee left the DOM — stop ticking until the next render restarts us.
      if (marqueeTimer) clearInterval(marqueeTimer);
      marqueeTimer = null;
      return;
    }
    tickTimestamps(host);
  }, 5000);
}

/* ── Copy-badge button (story page) ──
 * Binds [data-copy-badge]: on click copy the markdown snippet to the clipboard
 * (navigator.clipboard with a textarea/execCommand fallback) and flash a brief
 * "Copied!" state. A per-button timeout id is stored on the element so we can
 * clear it; nothing leaks across route changes because re-rendering replaces the
 * element entirely (and the timeout only mutates a node that may be detached —
 * which is harmless).
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function bindCopyBadge(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>("[data-copy-badge]");
  if (!btn) return;
  const label = btn.querySelector<HTMLElement>("[data-copy-label]");
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  btn.addEventListener("click", async () => {
    const text = btn.dataset.copyText ?? "";
    const ok = await copyText(text);
    if (label) label.textContent = ok ? "Copied!" : "Copy failed";
    btn.classList.toggle("bg-lime", ok);
    btn.classList.toggle("bg-coral", !ok);
    btn.classList.toggle("text-white", !ok);
    btn.classList.remove("bg-sun");
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (label) label.textContent = "Copy";
      btn.classList.remove("bg-lime", "bg-coral", "text-white");
      btn.classList.add("bg-sun");
    }, 1600);
  });
}

/**
 * Wires the Receipts Attached Card after a story render:
 *  - presses the wax seal exactly ONCE (skipped under reduced motion — the seal
 *    markup is already authored in its final pressed frame);
 *  - confirms the bundle hash client-side and reflects match/mismatch;
 *  - binds "Fetch & re-hash" to pull the bundle back from 0G Storage and re-hash.
 *
 * The fetch target comes from data-bundle-url, which renderReceiptsDrawer
 * already resolved to a BROWSER-FETCHABLE HTTP 0G Storage gateway URL. This code
 * NEVER constructs a `0g://…` request (browsers cannot fetch that scheme). If no
 * public gateway existed, the button is absent and this is a no-op (the always-on
 * verifyAgainst0G sidecar rows still show the publisher-REPORTED publish-time read-back
 * claim — muted, never trustless green; only this live fetch produces trustless green).
 */
function bindReceiptsCard(root: HTMLElement): void {
  // 1. The ONE hero animation — press the seal once (attested/cracked only; the
  //    structural-only placeholder has nothing to press, but the class is inert there).
  const seal = root.querySelector<HTMLElement>("[data-seal-press]");
  if (seal && !prefersReducedMotion()) {
    // Force a frame so the transform starts from the 1.18 scale keyframe.
    requestAnimationFrame(() => seal.classList.add("seal-press"));
  }

  // 2. Click-to-copy for every [data-copy] hash/address in the receipt. Bound ONCE
  //    on the persistent #app root (delegated), so it survives every route re-render
  //    without accumulating duplicate listeners — it reads the live DOM at click
  //    time. Each [data-copy] carries the FULL value; clicking (or Enter/Space)
  //    copies it and briefly swaps the label to "copied!". Replaces the dead links
  //    we removed — a reader grabs the full value instead of following a broken anchor.
  if (!root.dataset.copyDelegationBound) {
    root.dataset.copyDelegationBound = "1";
    const flashCopy = async (el: HTMLElement): Promise<void> => {
      const full = el.dataset.copy ?? "";
      // Re-entrancy guard: ignore repeat activations while the "copied!" label shows,
      // otherwise the second call would capture the swapped text as the original.
      if (!full || el.dataset.copyFlashing) return;
      el.dataset.copyFlashing = "1";
      const ok = await copyText(full);
      const original = el.textContent ?? "";
      el.textContent = ok ? "copied!" : "copy failed";
      el.classList.add(ok ? "text-lime" : "text-coral");
      setTimeout(() => {
        el.textContent = original;
        el.classList.remove("text-lime", "text-coral");
        delete el.dataset.copyFlashing;
      }, 1100);
    };
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-copy]");
      if (target && root.contains(target)) void flashCopy(target);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-copy]");
      if (target && root.contains(target)) {
        event.preventDefault();
        void flashCopy(target);
      }
    });
  }

  // 3. Live client-side re-hash of the bundle hash row (advisory — the row already
  //    shows the expected hash; we only flag a mismatch by tinting it).
  const liveRow = root.querySelector<HTMLElement>("[data-live-rehash]");
  const expected = liveRow?.getAttribute("data-expected-hash") ?? "";

  // 4. Fetch & re-hash: the real trustless 0G Storage read-back over HTTP.
  const btn = root.querySelector<HTMLButtonElement>("[data-fetch-rehash]");
  const result = root.querySelector<HTMLElement>("[data-fetch-rehash-result]");
  if (!btn) return;
  const bundleUrl = btn.getAttribute("data-bundle-url") ?? "";
  const expectedHash = btn.getAttribute("data-expected-hash") ?? expected;

  // Defence-in-depth: refuse to fetch anything that is not an HTTP(S) gateway URL.
  if (!/^https?:\/\//.test(bundleUrl)) return;

  btn.addEventListener("click", async () => {
    if (result) result.textContent = "fetching…";
    try {
      const res = await fetch(bundleUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fetched = (await res.json()) as PublicLedgerBundle;
      const recomputed = hashPublicLedgerBundle(fetched);
      const matches = recomputed === expectedHash;
      if (result) {
        // "verified live against 0G ✓" is the ONLY bold-green trustless state.
        // This is distinct from the muted "reported at publish" sidecar rows.
        result.textContent = matches ? "verified live against 0G ✓" : "MISMATCH ✕";
        result.className = matches ? "text-lime font-bold" : "text-wax font-bold";
      }
    } catch (err) {
      if (result) {
        result.textContent = `read failed: ${err instanceof Error ? err.message : String(err)}`;
        result.className = "text-wax font-bold";
      }
    }
  });
}

/* ── Routing ── */

function renderLoading(): string {
  return `
    ${renderNav()}
    <main class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-20" aria-busy="true" aria-label="Loading">
      <div class="inline-flex items-center gap-3 b3 bg-white hard px-4 py-3 font-mono text-sm font-bold uppercase tracking-wide">
        <span class="w-3 h-3 bg-lime b2 rounded-full inline-block" aria-hidden="true"></span>
        Loading the ledger…
      </div>
    </main>`;
}

function renderError(message: string): string {
  return `
    ${renderNav()}
    ${renderLiveMarquee(registry)}
    <main class="max-w-3xl mx-auto px-6 py-16">
      <a href="#/" class="inline-flex items-center gap-1.5 b3 bg-paper hard lift px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wide mb-5">← Home</a>
      <div class="b4 bg-white hard-xl p-8">
        <div class="inline-block b3 bg-coral text-white px-3 py-1.5 hard font-display text-lg uppercase tracking-wide -rotate-1 mb-5">Not Found</div>
        <p class="font-mono text-sm text-ink/80 mb-3">${escapeHtml(message)}</p>
        <p class="font-mono text-sm text-ink/60">Pass <code class="bg-ink text-lime px-1.5">?bundle=&lt;url&gt;</code> to render an external VibeTrace public bundle, or head to the <a href="#/leaderboard" class="text-blue font-bold underline">leaderboard</a>.</p>
      </div>
    </main>`;
}

async function fetchExternalBundle(bundleUrl: string): Promise<PublicLedgerBundle> {
  // Only allow http(s): URLs — 0g://, file://, and other schemes are not browser-fetchable
  // and would silently fail or expose local files.
  let parsed: URL;
  try {
    parsed = new URL(bundleUrl);
  } catch {
    throw new Error(`Invalid bundle URL: ${bundleUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Bundle URL must be http(s); got: ${parsed.protocol}`);
  }
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`Unable to load bundle: ${response.status}`);
  }
  return (await response.json()) as PublicLedgerBundle;
}

async function render(): Promise<void> {
  if (!app) return;

  // Reset any active motion before re-rendering; each route re-inits its own.
  teardownMotion();

  // ?bundle=<url> always wins: fetch + score + render that external story.
  const url = new URL(window.location.href);
  const bundleUrl = url.searchParams.get("bundle");
  if (bundleUrl) {
    try {
      const bundle = await fetchExternalBundle(bundleUrl);
      const score = scoreBundle(bundle);
      // External ?bundle=<url> story has no registry id → no badge (prompt to submit).
      app.innerHTML = renderNav("story") + renderBundle(bundle, score, registry);
      bindCopyBadge(app);
      bindReceiptsCard(app);
    } catch (error) {
      app.innerHTML = renderError(error instanceof Error ? error.message : String(error));
    }
    startMarquee(app);
    initMotion("story");
    return;
  }

  const hash = window.location.hash.replace(/^#/, "");
  const projectMatch = /^\/p\/(.+)$/.exec(hash);

  // Per-project story page.
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]);
    try {
      const bundle = await getBundleEntry(id);
      const score = scoreBundle(bundle);
      // Registry-backed story → pass the id so the embeddable badge section renders.
      app.innerHTML = renderNav("story") + renderBundle(bundle, score, registry, id);
      bindCopyBadge(app);
      bindReceiptsCard(app);
    } catch (error) {
      app.innerHTML = renderError(error instanceof Error ? error.message : String(error));
    }
    startMarquee(app);
    initMotion("story");
    window.scrollTo(0, 0);
    return;
  }

  // Leaderboard page (its own route).
  if (hash === "/leaderboard") {
    app.innerHTML = renderLeaderboard(registry);
    startMarquee(app);
    // The "Get on the board" callout reuses the [data-copy-badge] copy button.
    bindCopyBadge(app);
    initMotion("leaderboard");
    window.scrollTo(0, 0);
    return;
  }

  // #/ or empty hash → the product landing.
  app.innerHTML = renderNav("landing") + renderLanding(registry);
  startMarquee(app);
  initMotion("landing");
}

/* ── Boot ── */

// Tasteful loading state while the first registry fetch is in flight.
app.innerHTML = renderLoading();

// Ambient "ledger remembers the hands" background — a behind-content layer that
// reveals faint agent/model logos on the grid as the cursor moves. Page-global,
// mounted once; persists across routes (lives on <body>, not inside #app).
// No-op under reduced motion / non-browser.
initModelMarks();

getRegistry()
  .then((entries) => {
    registry = entries;
    registryLoaded = true;
    return render();
  })
  .catch((error) => {
    registryLoaded = true;
    if (app) app.innerHTML = renderError(error instanceof Error ? error.message : String(error));
  });

window.addEventListener("hashchange", () => {
  // If the first load hasn't resolved yet, keep showing the loading state;
  // the boot .then() will render the correct route once data arrives.
  if (!registryLoaded) {
    if (app) app.innerHTML = renderLoading();
    return;
  }
  void render();
});
