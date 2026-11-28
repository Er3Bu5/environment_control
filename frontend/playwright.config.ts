import { spawnSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/* CI installs Playwright's own Chromium. On a machine that already has one, CHROMIUM_PATH points at it instead. */
const executablePath = process.env.CHROMIUM_PATH || undefined;

/* PANEL_PORT lets several runs on one machine go side by side, each on its own port. */
const portSetting = process.env.PANEL_PORT ?? "4173";
if (!/^\d+$/.test(portSetting) || Number(portSetting) < 1024 || Number(portSetting) > 65535) {
  throw new Error(`PANEL_PORT must be a whole number from 1024 to 65535, not "${portSetting}"`);
}
const port = Number(portSetting);

/* A listener that never answers http leaves Playwright waiting on its url probe with no message, so try the port
   first. Workers load this file too, after the server is up, hence the marker they inherit. */
if (!process.env.PANEL_PORT_CHECKED) {
  const probe = `require("net").createServer().once("error", () => process.exit(1)).listen(${port}, "127.0.0.1", function () { this.close(); })`;
  if (spawnSync(process.execPath, ["-e", probe]).status !== 0) {
    throw new Error(`Port ${port} is already in use, maybe by another test run; pick another with PANEL_PORT`);
  }
  process.env.PANEL_PORT_CHECKED = "1";
}
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: origin, trace: "off" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], launchOptions: { executablePath } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
  ],
  /* Never reuse a server already on the port: it may be another run's, serving another worktree's build. */
  webServer: {
    command: "node test/e2e/server.mjs",
    url: `${origin}/frontend/test/e2e/page.html`,
    env: { PANEL_PORT: String(port) },
    reuseExistingServer: false,
  },
});
