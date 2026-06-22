/* ── Motion system (GSAP + Lenis) ──
 *
 * ONE cohesive easing language across every page. Neo-Brutal = "bold but
 * controlled": we lean on GSAP's `power4.out` / `power3.out` for snap and a
 * single shared duration scale. We animate ONLY transform + opacity (never
 * width/height/top) so everything stays on the compositor at 60fps.
 *
 * Contract with main.ts:
 *   initMotion(route)   — called AFTER the route's innerHTML is in the DOM.
 *   teardownMotion()    — called BEFORE each re-render so triggers/timelines
 *                         created for the previous page are killed (no leaks,
 *                         no duplicates across hash navigation).
 *
 * Reduced motion: if the user prefers reduced motion (or we're outside a real
 * browser, e.g. the node/jsdom test env) initMotion does NOTHING. The static
 * HTML is already the final, fully-visible state — there is no hidden content
 * to reveal — so "do nothing" is a correct, complete fallback.
 *
 * SSR / test safety: every entry point bails early if `window`/`document` are
 * missing, so importing this module never touches browser globals at import
 * time and calling its functions in node is a harmless no-op.
 */

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

/* ── Shared easing language + timing scale ── */
const EASE = "power4.out"; // the snap (hero lines, primary reveals)
const EASE_SOFT = "power3.out"; // gentle settles (cards, micro-lifts)
const DUR = 0.7; // base reveal duration
const DUR_FAST = 0.45; // micro-interactions
const STAGGER = 0.07; // 0.05–0.08 band for grouped reveals

/* ── Module state (so teardown can clean up exactly what we built) ── */
let lenis: Lenis | null = null;
let tickerFn: ((time: number) => void) | null = null;
let registered = false;
/** Page-scoped GSAP objects + DOM listeners to kill on teardown. */
let pageTweens: gsap.core.Tween[] = [];
let pageTimelines: gsap.core.Timeline[] = [];
let pageTriggers: ScrollTrigger[] = [];
let cleanups: Array<() => void> = [];

function hasDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function reducedMotion(): boolean {
  return (
    !hasDom() ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ── Lenis smooth scroll, driven by the GSAP ticker and wired to ScrollTrigger ──
 *
 * The critical integration pattern: ONE Lenis instance; its scroll event pumps
 * ScrollTrigger.update; the GSAP ticker drives lenis.raf (so there's a single
 * rAF loop); lagSmoothing(0) keeps scroll-linked work honest after stalls.
 * Created lazily on first init and reused across route changes (we never tear
 * down smooth-scroll itself, only the per-page triggers).
 */
function ensureSmoothScroll(): void {
  if (!hasDom()) return;
  if (!registered) {
    gsap.registerPlugin(ScrollTrigger);
    registered = true;
  }
  if (lenis) return;

  lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  tickerFn = (time: number) => {
    lenis?.raf(time * 1000);
  };
  gsap.ticker.add(tickerFn);
  gsap.ticker.lagSmoothing(0);
}

/* ── Tracked helpers so teardown is exact ── */

function track<T extends gsap.core.Tween | gsap.core.Timeline>(anim: T): T {
  if (anim instanceof gsap.core.Timeline) pageTimelines.push(anim);
  else pageTweens.push(anim as gsap.core.Tween);
  return anim;
}

/** Rise + fade a set of elements in on scroll-enter, once, staggered. */
function revealOnScroll(
  els: Element[],
  opts: { y?: number; stagger?: number; trigger?: Element; start?: string } = {}
): void {
  if (els.length === 0) return;
  const y = opts.y ?? 28;
  const tween = gsap.from(els, {
    opacity: 0,
    y,
    duration: DUR,
    ease: EASE_SOFT,
    stagger: opts.stagger ?? STAGGER,
    scrollTrigger: {
      trigger: opts.trigger ?? els[0],
      start: opts.start ?? "top 86%",
      once: true
    }
  });
  track(tween);
  const st = tween.scrollTrigger;
  if (st) pageTriggers.push(st);
}

/** Query helper scoped to the app root (falls back to document). */
function qa(sel: string, root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(sel));
}

/* ── Organic micro-interactions ── */

/**
 * Smooth GSAP-driven hover lift for hard-shadow blocks. Replaces the CSS
 * :hover transition feel with the shared ease (quickTo = no tween churn).
 * We override the CSS `.lift` transition while hovering so the two don't fight,
 * and restore it on teardown.
 */
function enhanceLifts(els: Element[]): void {
  for (const el of els) {
    const node = el as HTMLElement;
    const prevTransition = node.style.transition;
    node.style.transition = "none";
    const xTo = gsap.quickTo(node, "x", { duration: DUR_FAST, ease: EASE_SOFT });
    const yTo = gsap.quickTo(node, "y", { duration: DUR_FAST, ease: EASE_SOFT });
    const enter = () => {
      xTo(-3);
      yTo(-3);
    };
    const leave = () => {
      xTo(0);
      yTo(0);
    };
    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    cleanups.push(() => {
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      gsap.set(node, { clearProps: "transform" });
      node.style.transition = prevTransition;
    });
  }
}

/**
 * Tasteful magnetic pull toward the cursor for primary CTAs + the logo. The
 * element eases toward a fraction of the pointer offset, snapping back on
 * leave with the shared ease. Pointer-only (skipped on coarse/touch pointers).
 */
function magnetic(els: Element[], strength = 0.32): void {
  if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
    return;
  }
  for (const el of els) {
    const node = el as HTMLElement;
    const xTo = gsap.quickTo(node, "x", { duration: DUR_FAST, ease: EASE_SOFT });
    const yTo = gsap.quickTo(node, "y", { duration: DUR_FAST, ease: EASE_SOFT });
    const move = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      xTo(dx * strength);
      yTo(dy * strength);
    };
    const leave = () => {
      xTo(0);
      yTo(0);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    cleanups.push(() => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
      gsap.set(node, { clearProps: "transform" });
    });
  }
}

/* ── "How it works" timeline story ──
 *
 * One ScrollTrigger timeline drives the whole section as a sequential narrative:
 * the spine DRAWS IN (scaleX 0→1 from its left origin), then each step lands in
 * order — its number badge "stamps" in (scale+rotate with the snappy EASE) and
 * its card rises+fades (settle EASE_SOFT), staggered so the eye follows
 * capture→link→verify→anchor→publish. Reduced motion never reaches here
 * (initMotion bails), so the static HTML stays fully visible with no spine draw.
 */
function buildHowItWorksTimeline(root: ParentNode): void {
  const section = root.querySelector("section[aria-labelledby='how-h']");
  if (!section) return;
  const spine = section.querySelector(".vt-how-spine");
  const steps = qa(".vt-how-step", section);
  const badges = qa(".vt-how-badge", section);
  if (steps.length === 0) return;

  const tl = gsap.timeline({
    defaults: { ease: EASE },
    scrollTrigger: { trigger: section, start: "top 78%", once: true }
  });

  // 1) The spine draws from the start (origin-left set in markup).
  if (spine) {
    tl.from(spine, { scaleX: 0, duration: DUR, ease: EASE }, 0);
  }

  // 2) Each step reveals SEQUENTIALLY: card rises+fades while its badge stamps in.
  const STEP_STAGGER = 0.15; // 0.12–0.18 band so it reads as a timeline
  steps.forEach((step, i) => {
    const at = (spine ? 0.18 : 0) + i * STEP_STAGGER;
    tl.from(step, { opacity: 0, y: 26, duration: DUR, ease: EASE_SOFT }, at);
    const badge = badges[i];
    if (badge) {
      tl.from(
        badge,
        { scale: 0, rotate: -28, transformOrigin: "50% 50%", duration: DUR_FAST, ease: EASE },
        at + 0.04
      );
    }
  });

  track(tl);
  const st = tl.scrollTrigger;
  if (st) pageTriggers.push(st);
}

/* ── Per-route builders ── */

function buildLanding(root: ParentNode): void {
  // HERO entrance — one clear moment. The headline lines clip+rise, the
  // "built with AI" highlight settles, the seal asset scales/rotates in.
  const heroH = root.querySelector("#hero-h");
  const heroBadge = root.querySelector("#hero-h")?.previousElementSibling ?? null;
  const heroPara = heroH?.parentElement?.querySelector("p") ?? null;
  const heroCtas = heroH?.parentElement?.querySelector("div.mt-8") ?? null;
  const seal = root.querySelector(".vt-hero");

  const tl = gsap.timeline({ defaults: { ease: EASE } });
  if (heroBadge) tl.from(heroBadge, { opacity: 0, y: 16, duration: DUR_FAST }, 0);
  if (heroH) {
    // Reveal the two headline lines as a clip+translate stagger.
    tl.from(
      heroH,
      { opacity: 0, yPercent: 18, duration: DUR, clipPath: "inset(0 0 100% 0)" },
      0.08
    );
  }
  const coral = heroH?.querySelector("span");
  if (coral) tl.from(coral, { scaleX: 0, transformOrigin: "left center", duration: DUR_FAST, ease: "power2.out" }, 0.42);
  if (heroPara) tl.from(heroPara, { opacity: 0, y: 18, duration: DUR }, 0.32);
  if (heroCtas) tl.from(heroCtas.children, { opacity: 0, y: 18, duration: DUR, stagger: STAGGER }, 0.42);
  if (seal) tl.from(seal, { opacity: 0, scale: 0.86, rotate: -6, duration: DUR + 0.1, ease: "power3.out" }, 0.2);
  track(tl);

  // The hero seal is a STATIC stamp: no continuous float/rotate idle. Its only
  // motion is the one-shot entrance reveal in the timeline above.

  // HOW IT WORKS — animated as a sequential TIMELINE STORY (see below).
  buildHowItWorksTimeline(root);

  // SCROLL REVEALS — how-it-works beats, vibescore block + tier ladder,
  // leaderboard peek rows. Each rises+fades once, staggered.
  for (const section of qa("section[aria-labelledby]", root)) {
    if (section.querySelector("#hero-h")) continue; // hero handled by the timeline
    const heading = section.querySelector("h2");
    if (heading) revealOnScroll([heading], { trigger: section, y: 22 });
  }
  // (How-it-works steps are revealed by buildHowItWorksTimeline, not here.)
  revealOnScroll(qa("section[aria-labelledby='score-h'] > div > div", root), { stagger: 0.06, y: 24 });
  revealOnScroll(qa("section[aria-labelledby='score-h'] li", root), { stagger: 0.05, y: 16 });
  revealOnScroll(qa("section[aria-labelledby='wild-h'] a", root), { stagger: 0.06 });
  revealOnScroll(qa("#integrate > div", root), { y: 30 });

  // Micro-interactions.
  enhanceLifts(qa(".lift-lg, .lift", root));
  magnetic(qa('a[href="#/leaderboard"].hard-lg, a[href="#integrate"]', root));
  const logo = root.querySelector('nav a[aria-label="VibeTrace home"]');
  if (logo) magnetic([logo], 0.25);
}

function buildLeaderboard(root: ParentNode): void {
  const header = root.querySelector("header");
  if (header) {
    const tl = gsap.timeline({ defaults: { ease: EASE } });
    const badge = header.querySelector("div");
    const h1 = header.querySelector("h1");
    const para = header.querySelector("p");
    if (badge) tl.from(badge, { opacity: 0, y: 14, duration: DUR_FAST }, 0);
    if (h1) tl.from(h1, { opacity: 0, yPercent: 14, duration: DUR, clipPath: "inset(0 0 100% 0)" }, 0.06);
    if (para) tl.from(para, { opacity: 0, y: 16, duration: DUR }, 0.28);
    track(tl);
  }

  revealOnScroll(qa("section[aria-labelledby='board-h']", root), { y: 26 });
  // Leaderboard rows rise + fade, staggered, once.
  revealOnScroll(qa("section[aria-label='Leaderboard'] > a", root), { stagger: STAGGER, y: 26 });
  revealOnScroll(qa("section[aria-label='No submissions yet']", root), { y: 26 });

  enhanceLifts(qa(".lift-lg, .lift", root));
  magnetic(qa("[data-copy-badge]", root));
  const logo = root.querySelector('nav a[aria-label="VibeTrace home"]');
  if (logo) magnetic([logo], 0.25);
}

function buildStory(root: ParentNode): void {
  const hook = root.querySelector("h1");
  if (hook) {
    const tl = gsap.timeline({ defaults: { ease: EASE } });
    const label = hook.previousElementSibling;
    const para = hook.parentElement?.querySelector("p") ?? null;
    if (label) tl.from(label, { opacity: 0, y: 12, duration: DUR_FAST }, 0);
    tl.from(hook, { opacity: 0, yPercent: 14, duration: DUR, clipPath: "inset(0 0 100% 0)" }, 0.06);
    if (para) tl.from(para, { opacity: 0, y: 16, duration: DUR }, 0.28);
    track(tl);
  }

  // The proof hero (VibeScore certificate) reveals as one block.
  revealOnScroll(qa("section[aria-labelledby='vibetrace-score-h']", root), { y: 28 });
  // Build-story beats rise + fade, staggered, once.
  revealOnScroll(qa("section[aria-labelledby='story-h'] article", root), { stagger: STAGGER });
  revealOnScroll(qa("section[aria-labelledby='story-h'] h2", root), { y: 20 });
  revealOnScroll(qa("#proof-strip", root), { y: 26 });
  revealOnScroll(qa("section[aria-labelledby='embed-h'] > div", root), { y: 28 });

  enhanceLifts(qa(".lift-lg, .lift", root));
  magnetic(qa("[data-copy-badge]", root));
  const logo = root.querySelector('nav a[aria-label="VibeTrace home"]');
  if (logo) magnetic([logo], 0.25);
}

/* ── Public API ── */

/**
 * Initialize motion for a route. MUST be called after the route's innerHTML is
 * in the DOM. No-op under reduced motion / non-browser (content already shown).
 */
export function initMotion(route: string): void {
  if (reducedMotion()) return;

  ensureSmoothScroll();
  const root: ParentNode = document.querySelector("#app") ?? document;

  // GSAP context isn't strictly needed since we track everything, but building
  // inside a try keeps a malformed selector from ever breaking navigation.
  try {
    if (route === "landing") buildLanding(root);
    else if (route === "leaderboard") buildLeaderboard(root);
    else if (route === "story") buildStory(root);
  } catch {
    /* motion is decorative — never let it break the page */
  }

  ScrollTrigger.refresh();
}

/**
 * Tear down every page-scoped tween, timeline, ScrollTrigger, and DOM listener
 * created by the last initMotion. Smooth-scroll (Lenis + the ticker) persists
 * across routes by design. Safe to call when nothing is active.
 */
export function teardownMotion(): void {
  if (!hasDom()) return;

  for (const c of cleanups) c();
  cleanups = [];
  for (const t of pageTriggers) t.kill();
  pageTriggers = [];
  for (const tl of pageTimelines) tl.kill();
  pageTimelines = [];
  for (const tw of pageTweens) tw.kill();
  pageTweens = [];

  // Restore any elements left mid-tween to their natural (final) state.
  if (lenis) lenis.scrollTo(0, { immediate: true });
}
