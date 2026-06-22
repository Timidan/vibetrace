import { defineConfig } from "@playwright/test";

/**
 * E2E config for the VibeTrace viewer SPA. Runs against the dev server on
 * :5173. Uses the system Chromium (already present) via executablePath so we
 * don't depend on a pinned Playwright browser revision.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-gpu"],
    },
  },
});
