import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function readStyles(): Promise<string> {
  return readFile(join(process.cwd(), "apps/viewer/src/styles.css"), "utf8");
}

describe("neo-brutal stylesheet", () => {
  it("imports tailwind v4 and ports the neo-brutal palette into a @theme block", async () => {
    const css = await readStyles();
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain("@theme");
    expect(css).toContain("--color-blue: #1d4ed8");
    expect(css).toContain("--color-coral: #fb4d26");
    expect(css).toContain("--color-lime: #c6f135");
    expect(css).toContain("--color-violet: #6d28d9");
    expect(css).toContain('--font-display: "Archivo Black"');
  });

  it("defines hard offset-shadow and hover-lift utilities", async () => {
    const css = await readStyles();
    expect(css).toMatch(/@utility hard\s*\{[^}]*box-shadow:\s*var\(--shadow\)/);
    expect(css).toMatch(/@utility lift\s*\{[^}]*transition:/);
    expect(css).toContain(".lift:hover");
  });

  it("defines the stamp keyframes and gates motion behind prefers-reduced-motion", async () => {
    const css = await readStyles();
    expect(css).toContain("@keyframes stampIn");
    expect(css).toContain("@keyframes spinSlow");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lift[\s\S]*transition:\s*none/);
  });

  it("drops the pulsing-dot keyframes (no blink/pulseRing) the user disliked", async () => {
    const css = await readStyles();
    expect(css).not.toContain("@keyframes pulseRing");
    expect(css).not.toContain("@keyframes ticker");
    expect(css).not.toMatch(/^\.blink\s*\{/m);
    expect(css).not.toMatch(/^\.ring\s*\{/m);
  });
});

describe("receipts card — wax seal tokens + seal-press keyframe", () => {
  it("defines the wax + paper-light examiner tokens reserved for the seal", async () => {
    const css = await readStyles();
    expect(css).toContain("--color-wax: #b3122b");
    expect(css).toContain("--color-paperlight: #f5f0e6");
  });

  it("defines a one-shot seal-press keyframe with the locked easing", async () => {
    const css = await readStyles();
    expect(css).toContain("@keyframes sealPress");
    expect(css).toMatch(/\.seal-press\s*\{[\s\S]*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
    // fires exactly once: forwards, no infinite
    expect(css).toMatch(/\.seal-press\s*\{[\s\S]*forwards/);
    expect(css).not.toMatch(/\.seal-press\s*\{[\s\S]*infinite/);
  });

  it("renders the seal pre-pressed (final frame) under reduced motion", async () => {
    const css = await readStyles();
    // the reduced-motion block must neutralise the seal-press animation
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.seal-press[\s\S]*animation:\s*none/);
  });
});
