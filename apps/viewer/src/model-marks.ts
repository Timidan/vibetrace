/* ── Model marks — ambient "the ledger remembers the hands" background ──
 *
 * A single fixed layer painted BEHIND all content, over the body's 28px ledger
 * grid. Moving the cursor (and only that — never autonomously) develops an
 * official logo of a coding agent / model in the square the cursor is on, sized
 * to sit inside that square, holding with a faint "thinking" shimmer before it
 * fades. The placement tracks the cursor; only the FREQUENCY is random — some
 * squares you cross light up, some don't.
 *
 * Why this and not decoration: VibeTrace's whole job is recording which model
 * built your code — the trace literally stores the model. So the substrate
 * surfacing those agents as you touch the page IS the product's thesis, not an
 * ornament. It stays a watermark: low opacity, one mark at a time, off until
 * the pointer moves.
 *
 * Constraints honored:
 *   - Official marks only (Simple Icons, CC0), normalized 24×24 → fit one cell.
 *   - Appear ONLY on pointer movement, in the square under the cursor.
 *   - Frequency is random — not every crossed square reveals a logo.
 *   - Each glyph fits inside one grid square (never overflows a neighbor).
 *   - prefers-reduced-motion / non-browser (tests, SSR) → no-op.
 *
 * Lifecycle: page-global ambient. initModelMarks() once at boot; it persists
 * across hash routes (the layer lives on <body>, independent of #app renders).
 */

import { PROVIDERS } from "./model-marks-data";

// Grid geometry is read from the CSS custom property --vt-grid (the single source
// of truth shared with the body ledger grid in styles.css), resolved at init().
let cell = 48; // px per square — fallback; overwritten from --vt-grid
let glyph = 32; // px logo size — kept < cell so a mark sits inside one square
const PEAK = 1; // opacity of a mark at its hold — full brand color (lower for a fainter watermark)
const TEXT_PEAK = 0.2; // reduced opacity when a mark lands over text, so it never competes with copy
const SPAWN_CHANCE = 0.35; // per NEW square entered: probability it reveals a logo → random frequency
const MAX_MARKS = 3; // at most this many logos on screen at once — keeps it calm, kills the "trail" look

let layer: HTMLElement | null = null;
let onMove: ((e: PointerEvent) => void) | null = null;
let lastIx = -1;
let lastIy = -1;
let lastProvider = -1; // index of the most recent logo — never repeated back-to-back
const occupied = new Set<string>(); // cell keys "ix,iy" currently showing a mark — no stacking
const visible = new Set<number>(); // provider indices currently on screen — never duplicated

type ActiveMark = { el: HTMLElement; key: string; idx: number };
const active: ActiveMark[] = []; // live marks, oldest first — the rolling MAX_MARKS window

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

/** Resolve the grid square size from --vt-grid (px). Falls back to the current `cell`. */
function gridSize(): number {
  if (!hasDom() || typeof getComputedStyle !== "function") return cell;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--vt-grid");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : cell;
}

/** Typographic tags whose box, if under a mark, means the mark sits over copy. */
const TEXT_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "A", "SPAN", "CODE", "PRE", "STRONG",
  "EM", "B", "I", "LABEL", "BUTTON", "BLOCKQUOTE", "TD", "TH", "FIGCAPTION", "SMALL", "TIME"
]);

/** Is the viewport point over rendered text? The marks layer is pointer-events:none,
 *  so elementFromPoint returns the content beneath it; we climb a few levels to a
 *  text-bearing element. Used to fade marks that would otherwise hurt legibility. */
function overText(cx: number, cy: number): boolean {
  if (typeof document.elementFromPoint !== "function") return false;
  let node = document.elementFromPoint(cx, cy);
  for (let i = 0; i < 4 && node; i++) {
    if (TEXT_TAGS.has(node.tagName) && (node.textContent ?? "").trim().length > 0) return true;
    node = node.parentElement;
  }
  return false;
}

/** Pick a provider that is neither the previous pick nor currently on screen, so a
 *  logo never renders twice in a row (nor appears twice at once). */
function pickProviderIndex(): number {
  const n = PROVIDERS.length;
  let idx = Math.floor(Math.random() * n);
  for (let guard = 0; (idx === lastProvider || visible.has(idx)) && guard < n; guard++) {
    idx = (idx + 1) % n;
  }
  return idx;
}

/** Drop a mark's bookkeeping and remove its node (used when its develop animation ends). */
function retire(m: ActiveMark): void {
  const i = active.indexOf(m);
  if (i < 0) return; // already gone (e.g. evicted)
  active.splice(i, 1);
  occupied.delete(m.key);
  visible.delete(m.idx);
  m.el.remove();
}

/** Forcefully retire a mark to honor the cap, fading it out fast so it never pops. */
function evict(m: ActiveMark): void {
  const i = active.indexOf(m);
  if (i < 0) return;
  active.splice(i, 1);
  occupied.delete(m.key);
  visible.delete(m.idx);
  const el = m.el;
  // Freeze the current animated value, then transition it to 0 (a hard remove would pop).
  const cs = getComputedStyle(el);
  el.style.transform = cs.transform && cs.transform !== "none" ? cs.transform : "translate(-50%, -50%)";
  el.style.opacity = cs.opacity;
  el.style.animation = "none";
  el.style.transition = "opacity 220ms ease";
  void el.offsetWidth; // reflow so the next change transitions instead of snapping
  el.style.opacity = "0";
  window.setTimeout(() => el.remove(), 260);
}

/** Develop one logo centred in the given grid cell (the square under the cursor). */
function spawnAt(ix: number, iy: number): void {
  if (!layer) return;
  const key = `${ix},${iy}`;
  if (occupied.has(key)) return; // a mark is already developing in this square — don't stack

  // Rolling window: the hovered square ALWAYS lights up — if we're at the cap,
  // retire the oldest mark to make room rather than dropping the new one.
  while (active.length >= MAX_MARKS) evict(active[0]);

  occupied.add(key);
  const idx = pickProviderIndex();
  const pr = PROVIDERS[idx];
  lastProvider = idx;
  visible.add(idx);

  const cx = ix * cell + cell / 2;
  const cy = iy * cell + cell / 2;
  // Over copy → fade so the mark never competes with text; in the gutters → full color.
  const peak = overText(cx, cy) ? TEXT_PEAK : PEAK;

  const el = document.createElement("div");
  el.className = "vt-mark";
  // Centre on the cell → the glyph keeps ~8px to each gridline; no overflow.
  el.style.left = `${cx}px`;
  el.style.top = `${cy}px`;
  el.style.color = pr.color;
  el.style.setProperty("--peak", String(peak));
  el.innerHTML = `<svg class="vt-mark-spark" width="${glyph}" height="${glyph}" viewBox="0 0 24 24" aria-hidden="true">${pr.svg}</svg>`;

  const mark: ActiveMark = { el, key, idx };
  el.addEventListener("animationend", (e) => {
    if ((e as AnimationEvent).animationName === "vtMarkIn") retire(mark);
  });
  active.push(mark);
  layer.appendChild(el);
}

/**
 * Mount the ambient layer and start revealing marks on pointer movement.
 * Idempotent and safe to call before the registry resolves. No-op under
 * reduced motion or outside a browser.
 */
export function initModelMarks(): void {
  if (reducedMotion() || layer) return;

  cell = gridSize();
  glyph = Math.max(12, cell - 16); // keep ~8px margin to each gridline so a mark never overflows

  layer = document.createElement("div");
  layer.id = "vt-model-marks";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  onMove = (e: PointerEvent) => {
    // The square the cursor is currently over.
    const ix = Math.floor(e.clientX / cell);
    const iy = Math.floor(e.clientY / cell);
    if (ix === lastIx && iy === lastIy) return; // still inside the same square — wait for the next one
    lastIx = ix;
    lastIy = iy;
    // Random FREQUENCY: only some of the squares you cross reveal a logo.
    if (Math.random() >= SPAWN_CHANCE) return;
    spawnAt(ix, iy);
  };
  window.addEventListener("pointermove", onMove, { passive: true });
}

/** Remove the layer and listener. Provided for completeness/tests; not used in the persistent boot path. */
export function teardownModelMarks(): void {
  if (!hasDom()) return;
  if (onMove) window.removeEventListener("pointermove", onMove);
  onMove = null;
  if (layer) {
    layer.remove();
    layer = null;
  }
  lastIx = -1;
  lastIy = -1;
  lastProvider = -1;
  occupied.clear();
  visible.clear();
  active.length = 0;
}
