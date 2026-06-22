import { logoMark } from "./assets";

/* ── Shared site FOOTER (rendered on every route) ──
 *
 * Neo-Brutal, single-line bar. Honest by design: a compact disclaimer makes
 * clear VibeScore is about submitted hash evidence — not a guarantee of code
 * quality or security. Full-bleed (flush to the bottom), no float, no pulsing
 * dots. Everything lives on ONE flowing row that wraps only on narrow screens.
 */

const YEAR = "2026";

/* Nav + contact collapsed into one inline link list for the single-line bar. */
const FOOTER_LINKS: { label: string; href: string }[] = [
  { label: "Home", href: "#/" },
  { label: "Leaderboard", href: "#/leaderboard" },
  { label: "GitHub", href: "https://github.com/" },
  { label: "X", href: "https://x.com/" },
  { label: "Email", href: "mailto:hello@vibetrace.dev" }
];

function linkRow(): string {
  return FOOTER_LINKS.map((l, i) => {
    const external = l.href.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
    const sep =
      i === 0
        ? ""
        : `<span aria-hidden="true" class="text-ink/25">·</span>`;
    return (
      `${sep}<a href="${l.href}"${external} class="hover:text-blue transition-colors whitespace-nowrap">${l.label}</a>`
    );
  }).join("");
}

/**
 * The site footer — a single-line Neo-Brutal bar: brand, a compact honesty
 * disclaimer, inline nav + contact links, and copyright. Wraps gracefully on
 * small screens; stays one line on desktop.
 */
export function renderFooter(): string {
  return `
    <footer class="border-t-4 border-ink bg-white" aria-label="Site footer">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div class="flex flex-wrap items-center justify-center sm:justify-between gap-x-4 gap-y-2">

          <!-- Brand + compact disclaimer -->
          <div class="flex items-center gap-2.5 min-w-0">
            <a href="#/" class="group inline-flex items-center gap-2 shrink-0" aria-label="VibeTrace home">
              <span class="b2 bg-lime grid place-items-center shrink-0 transition-transform group-hover:-rotate-6" style="width:28px;height:28px">
                ${logoMark(17, { tileFill: "transparent" })}
              </span>
              <span class="font-display text-base tracking-tight leading-none">VibeTrace</span>
            </a>
            <span aria-hidden="true" class="hidden lg:inline text-ink/25">·</span>
            <span class="hidden lg:inline font-mono text-[11px] text-ink/55 whitespace-nowrap">
              Hash evidence, not a quality guarantee.
            </span>
          </div>

          <!-- Inline nav + contact links -->
          <nav aria-label="Footer links"
               class="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 font-mono text-[11px] font-bold uppercase tracking-wide">
            ${linkRow()}
          </nav>

          <!-- Copyright -->
          <span class="font-mono text-[10px] font-bold uppercase tracking-wide text-ink/45 whitespace-nowrap shrink-0">
            © ${YEAR} VibeTrace
          </span>
        </div>
      </div>
    </footer>`;
}
