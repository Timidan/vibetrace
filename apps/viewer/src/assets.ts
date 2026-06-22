/* ── Hand-authored inline SVG assets ──
 *
 * No external images. Everything here is a string of inline SVG built from the
 * product metaphor — a STAMP / SEAL / proof-ledger glyph. Monochrome-friendly:
 * the logo mark reads at 24px (nav) and large; the hero is a bold composition
 * that reinforces "proof / stamp / build-story". Groups carry classes/ids so a
 * later motion phase can animate them.
 */

/**
 * The OFFICIAL 0G wordmark (exact path geometry from 0g.ai/brandkit — the
 * spiral "0" + "G" lockup), rendered inline with an RGB-split / VHS glitch
 * treatment so it sits on the text baseline and stands out. The brand mark is
 * drawn in 0G purple (#9200E1) on top, with coral/cyan glitch-offset copies
 * beneath. "0G" stays as the aria-label so it remains accessible and
 * test-discoverable. Motion lives in styles.css (.og0g) and is fully disabled
 * under prefers-reduced-motion (offset layers hide, brand mark stays).
 */
const OG_WORDMARK_PATH =
  "M551 140.176C547.524 210.803 489.168 267 417.687 267C343.972 267 284.212 207.229 284.212 133.499C284.212 59.769 343.972 0 417.687 0C486.9 0 543.808 52.6889 550.506 120.151H489.889C483.613 85.9722 453.674 60.0757 417.689 60.0757C377.144 60.0757 344.276 92.9486 344.276 133.499C344.276 174.052 377.144 206.925 417.689 206.925C448.816 206.925 475.416 187.549 486.095 160.201H384.32V140.176H551ZM43.9296 232.504C96.3218 279.985 177.314 278.45 227.858 227.899C279.983 175.763 279.983 91.2372 227.858 39.1014C175.732 -13.0328 91.22 -13.0328 39.0943 39.1014C-9.84622 88.0512 -12.8367 165.554 30.1224 217.994L72.9838 175.125C53.2597 146.519 56.1206 107.032 81.5664 81.5821C110.235 52.9077 156.717 52.9077 185.387 81.5821C214.055 110.257 214.055 156.746 185.387 185.421C163.377 207.435 130.868 212.548 103.981 200.76L175.948 128.78L161.791 114.622L86.4966 189.928L43.9296 232.504Z";

export function og0gGlitch(): string {
  const layer = (cls: string, fill: string): string =>
    `<path fill-rule="evenodd" clip-rule="evenodd" d="${OG_WORDMARK_PATH}" fill="${fill}" class="${cls}"/>`;
  return (
    `<span class="og0g" role="img" aria-label="0G">` +
    `<svg viewBox="0 0 551 267" aria-hidden="true" focusable="false">` +
    `<g class="og0g-layers">` +
    layer("og0g-r", "#fb4d26") +
    layer("og0g-c", "#22d3ee") +
    layer("og0g-k", "#9200E1") +
    `</g>` +
    `</svg>` +
    `</span>`
  );
}

/**
 * The VibeTrace LOGO mark — a chunky bordered tile holding the "vibe pulse": the
 * traced AI build signal terminating in an anchored (attested) node. Built to
 * read crisp at 17px and scale up cleanly. `size` sets width/height in px. The
 * glyph is monochrome ink on the tile; pass `tileFill` for the tile colour (or
 * "transparent" when the mark sits inside a coloured shell).
 *
 * Shares the vibe-pulse motif with the full seal in docs/assets/logo-mark.svg
 * and the favicon. Geometry uses a 32×32 viewBox so the strokes stay bold small.
 */
export function logoMark(size = 24, opts: { tileFill?: string; ink?: string } = {}): string {
  const tileFill = opts.tileFill ?? "#c6f135"; // lime tile by default
  const ink = opts.ink ?? "#0B0B0F";
  return `
    <svg viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-hidden="true"
         class="vt-logo" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g class="vt-logo-tile">
        <rect x="2" y="2" width="28" height="28" rx="2" fill="${tileFill}" stroke="${ink}" stroke-width="3"/>
      </g>
      <g class="vt-logo-glyph" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
        <!-- vibe pulse: the traced AI build signal -->
        <path class="vt-logo-pulse" d="M6 16H10l2.5-6.5L16.5 22.5 19 16h7"/>
      </g>
      <circle cx="26" cy="16" r="1.8" fill="${ink}"/>
    </svg>`;
}

/**
 * The VibeTrace WORDMARK lock-up: logo tile + "VibeTrace" text. Used in the nav
 * and footer. `accent` controls the tile color so it can match its surface.
 */
export function logoWordmark(opts: { size?: number; tileFill?: string } = {}): string {
  const size = opts.size ?? 36;
  return `
    <span class="vt-wordmark inline-flex items-center gap-2.5">
      <span class="vt-logo-shell b3 hard grid place-items-center shrink-0 transition-transform group-hover:-rotate-6"
            style="width:${size}px;height:${size}px;background:${opts.tileFill ?? "#c6f135"}">
        ${logoMark(Math.round(size * 0.62), { tileFill: "transparent" })}
      </span>
      <span class="font-display text-lg sm:text-xl tracking-tight leading-none">VibeTrace</span>
    </span>`;
}

/**
 * The HERO asset — a bold Neo-Brutal "AUTHENTICATED" seal composition. A large
 * stamped circular seal (concentric rings + circular text + the vibe pulse) over
 * an offset ledger card, with hard shadows and the saturated palette. Elements
 * are grouped with ids/classes (vt-hero-seal, vt-hero-ring, vt-hero-pulse,
 * vt-hero-ledger, vt-hero-chips) so the next phase can animate them.
 *
 * Static by design (no SVG <animate>, no spin): a clean stamped seal. The
 * circular AUTHENTICATED label sits NEATLY on the seal's own ring (its arc
 * radius matches the seal face), fully inside the artwork. Reduced motion is a
 * no-op because nothing here moves on its own.
 */
export function heroSeal(): string {
  return `
    <svg viewBox="0 0 360 360" class="vt-hero w-full h-auto max-w-[340px] mx-auto"
         role="img" aria-label="A stamped AUTHENTICATED proof seal over a build-ledger card"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Arc that hugs the seal's own ring (centered on the seal at 238,244,
             radius 58 — inside the r=62 dashed ring and r=74 face). Drawn as the
             TOP arc only so the label reads left-to-right across the crown. -->
        <path id="vt-hero-textpath" d="M180,244 a58,58 0 0,1 116,0"/>
        <pattern id="vt-hero-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#0B0B0F" stroke-opacity="0.12" stroke-width="1.5"/>
        </pattern>
      </defs>

      <!-- Offset ledger card behind the seal -->
      <g class="vt-hero-ledger">
        <rect x="44" y="78" width="252" height="220" rx="4" fill="#0B0B0F"/>
        <rect x="36" y="70" width="252" height="220" rx="4" fill="#fbf7ec" stroke="#0B0B0F" stroke-width="5"/>
        <rect x="36" y="70" width="252" height="220" rx="4" fill="url(#vt-hero-grid)"/>
        <!-- ledger header bar -->
        <rect x="36" y="70" width="252" height="34" fill="#1d4ed8"/>
        <circle cx="56" cy="87" r="5" fill="#c6f135" stroke="#0B0B0F" stroke-width="2"/>
        <circle cx="74" cy="87" r="5" fill="#ffc400" stroke="#0B0B0F" stroke-width="2"/>
        <circle cx="92" cy="87" r="5" fill="#fb4d26" stroke="#0B0B0F" stroke-width="2"/>
        <!-- ledger "lines of build story" -->
        <g class="vt-hero-lines" stroke="#0B0B0F" stroke-width="4" stroke-linecap="round" opacity="0.85">
          <path d="M58 134h120"/>
          <path d="M58 154h170"/>
          <path d="M58 174h96"/>
          <path d="M58 244h140"/>
          <path d="M58 264h84"/>
        </g>
        <!-- chip on the card: neutral, non-claim. The default run writes a local
             dev anchor, so this must NOT assert a specific real on-chain address
             nor an anchor STATE — it is a capability label ("0G real mode is
             opt-in"), not a fact about this card. -->
        <g class="vt-hero-chip">
          <rect x="170" y="232" width="92" height="44" rx="3" fill="#6d28d9" stroke="#0B0B0F" stroke-width="4"/>
          <text x="216" y="251" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" font-weight="700" fill="#fbf7ec">0G REAL MODE</text>
          <text x="216" y="266" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="10" font-weight="700" fill="#c6f135">OPT-IN · 0x⋯</text>
        </g>
      </g>

      <!-- The stamped seal, overlapping the card. STATIC clean stamp: concentric
           rings, a crown "AUTHENTICATED" arc on the seal's own ring, the vibe pulse,
           and a small 0G chip. No spin; entrance-only reveal lives in the GSAP
           timeline. -->
      <g class="vt-hero-seal" transform="translate(238 244) rotate(-8)">
        <!-- hard shadow disc -->
        <circle cx="6" cy="6" r="74" fill="#0B0B0F"/>
        <!-- seal face -->
        <circle cx="0" cy="0" r="74" fill="#c6f135" stroke="#0B0B0F" stroke-width="6"/>
        <!-- inner ring the crown text sits just inside of -->
        <circle cx="0" cy="0" r="62" fill="none" stroke="#0B0B0F" stroke-width="2"/>
        <!-- vibe pulse: the traced build signal, centered low so the crown text
             has room above; ends in an anchored (attested) node -->
        <path class="vt-hero-pulse" d="M-30 6 H-16 L-9 -11 L1 24 L8 6 H30" fill="none" stroke="#0B0B0F" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="30" cy="6" r="4.5" fill="#0B0B0F"/>
        <!-- small 0G anchor chip on the seal, under the pulse -->
        <text x="0" y="46" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="13" font-weight="700" letter-spacing="2" fill="#0B0B0F">0G</text>
      </g>

      <!-- Crown label rides the seal's own ring (radius 58, centered on the seal
           at 238,244). NOT scaled, NOT spinning, so it reads cleanly and stays
           inside the artwork. Slight rotate matches the seal's -8°. -->
      <g class="vt-hero-ring" transform="rotate(-8 238 244)">
        <text font-family="'JetBrains Mono',monospace" font-size="11" font-weight="700" letter-spacing="3.5" fill="#0B0B0F">
          <textPath href="#vt-hero-textpath" startOffset="50%" text-anchor="middle">· AUTHENTICATED ·</textPath>
        </text>
      </g>

      <!-- corner accent chips -->
      <g class="vt-hero-chips">
        <rect x="286" y="58" width="40" height="40" rx="2" fill="#fb4d26" stroke="#0B0B0F" stroke-width="4" transform="rotate(12 306 78)"/>
        <rect x="22" y="296" width="34" height="34" rx="2" fill="#ffc400" stroke="#0B0B0F" stroke-width="4" transform="rotate(-9 39 313)"/>
      </g>
    </svg>`;
}
