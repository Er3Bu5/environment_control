import { defineConfig, devices } from "@playwright/test";

/* CI installs Playwright's own Chromium. On a machine that already has one, CHROMIUM_PATH points at it instead. */
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "off" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], launchOptions: { executablePath } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
  ],
  webServer: { command: "node test/e2e/server.mjs", url: "http://127.0.0.1:4173/frontend/test/e2e/page.html", reuseExistingServer: !process.env.CI },
});
