/**
 * Playwright config for the demo-mode journey (PRD #297, S3 #301, S5 #386).
 *
 * Runs the app on its own port, isolated from the main serial journey. The demo
 * is a per-request state (ADR 0030): the journey enters it by picking a persona
 * at `/demo`, which sets the persona cookie — there is no deploy-wide `DEMO`
 * flag. No globalSetup and no `WORTHLINE_DB_PATH` — a demo request never opens
 * the live store; the store seam seeds each persona into an ephemeral in-memory
 * libSQL database per request, relative to the real date.
 *
 * To run (against a production build):
 *   npm run build --workspace @worthline/web
 *   CI=1 npx playwright test --config playwright.demo.config.ts
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const demoPort = Number(process.env.DEMO_PORT ?? 3004);
const demoBaseUrl = `http://127.0.0.1:${demoPort}`;

// Isolated, throwaway data dir — never the developer's real data. Demo mode does
// not read it (it seeds into the OS temp dir), but it keeps any stray live path
// off real data as a belt-and-braces measure.
const demoDataDir = mkdtempSync(join(tmpdir(), "worthline-demo-e2e-"));

// next dev allows only one server per app directory; serve the production build
// so this never collides with a developer's running `next dev` on :3000. The
// caller runs `next build` for the web app first.
const isCI = !!process.env.CI;

export default defineConfig({
  tsconfig: "./tsconfig.e2e.json",
  testDir: "./e2e",
  testMatch: /demo\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-demo" }],
  ],
  use: {
    baseURL: demoBaseUrl,
    actionTimeout: isCI ? 20_000 : 10_000,
    navigationTimeout: isCI ? 30_000 : 15_000,
    trace: "on-first-retry",
  },
  projects: [{ name: "demo", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start --workspace @worthline/web -- --port ${demoPort}`,
    url: demoBaseUrl,
    reuseExistingServer: false,
    env: {
      WORTHLINE_DATA_DIR: demoDataDir,
      NEXT_PUBLIC_ENABLE_SW: "1",
    },
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
