import { test, expect, type APIRequestContext } from "@playwright/test";

type RegistryEntry = {
  id: string;
  anchored: boolean;
  seal: string;
};

async function firstEntry(request: APIRequestContext): Promise<RegistryEntry> {
  const res = await request.get("/api/registry");
  expect(res.ok()).toBeTruthy();
  const entries = (await res.json()) as RegistryEntry[];
  expect(entries.length).toBeGreaterThanOrEqual(1);
  return entries[0];
}

function sealCopy(entry: RegistryEntry): RegExp {
  return entry.seal === "anchored" || entry.seal === "anchored-verified"
    ? /Anchor Recorded/i
    : entry.seal === "self-published"
      ? /Unanchored/i
      : /Integrity Broken/i;
}

test.describe("VibeTrace viewer e2e", () => {
  test("landing: hero, how-it-works, single-line footer, no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/#/");
    await expect(page.getByRole("heading", { name: /Prove/i })).toBeVisible();
    await expect(page.getByText(/built with AI/i).first()).toBeVisible();
    await expect(page.getByText(/How it works/i).first()).toBeVisible();

    const footer = page.locator('footer[aria-label="Site footer"]');
    await expect(footer).toBeVisible();
    await expect(footer.getByText(/Hash evidence, not a quality guarantee/i)).toBeVisible();

    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("leaderboard: shows the build with all three models + honest anchor seal", async ({ page }) => {
    const entry = await firstEntry(page.request);
    await page.goto("/#/leaderboard");
    await expect(page.getByRole("heading", { name: /Leaderboard/i })).toBeVisible();
    await expect(page.getByText("npx vibetrace").first()).toBeVisible();

    // Board row is client-fetched from /api/registry.
    await expect(page.getByRole("link", { name: /vibetrace/i }).first()).toBeVisible();
    await expect(page.getByText("gpt-5.5").first()).toBeVisible();
    await expect(page.getByText("claude-opus-4-8").first()).toBeVisible();
    // v2: the row shows a Build score + a separate proof pill (self-attested vs
    // independently verified). The proof status carries "self-attested" here.
    await expect(page.getByText(/self-attested/i).first()).toBeVisible();
  });

  test("story page: proof strip + honest anchor labeling", async ({ page }) => {
    const entry = await firstEntry(page.request);
    await page.goto(`/#/p/${entry.id}`);
    await expect(page.getByText(/Bundle Fingerprint/i)).toBeVisible();
    if (entry.anchored) {
      await expect(page.getByText(/ANCHORED ON 0G/i).first()).toBeVisible();
      await expect(page.getByText(/matches on-chain anchor/i).first()).toBeVisible();
    } else {
      await expect(page.getByText(/DEV ANCHOR|ANCHOR PENDING|CHAIN MANIFEST MISSING/i).first()).toBeVisible();
      await expect(page.getByText(/matches on-chain anchor/i)).toHaveCount(0);
    }
  });

  test("badge endpoint returns a valid SVG for the entry", async ({ request }) => {
    const entry = await firstEntry(request);
    const res = await request.get(`/api/badge/${entry.id}.svg`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("svg");
    expect(await res.text()).toContain("<svg");
  });

  test("nav: landing → leaderboard via footer/nav link", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("link", { name: /leaderboard/i }).first().click();
    await expect(page).toHaveURL(/#\/leaderboard/);
    await expect(page.getByRole("heading", { name: /Leaderboard/i })).toBeVisible();
  });
});
