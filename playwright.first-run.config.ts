/**
 * Playwright config for the first-run hogar onboarding spec.
 *
 * Runs in complete isolation from the main serial journey: its own throwaway
 * SQLite file and its own Next.js dev server on a separate port, so /empezar
 * is reachable (no workspace exists yet → no redirect to /).
 *
 * To run:
 *   npm run test:e2e:first-run
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const firstRunDbDir = mkdtempSync(join(tmpdir(), "worthline-first-run-"));
const firstRunDbPath = join(firstRunDbDir, "test.sqlite");
const firstRunPort = Number(process.env.FIRST_RUN_PORT ?? 3002);
const firstRunBaseUrl = `http://127.0.0.1:${firstRunPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /first-run-hogar\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-first-run" }],
  ],
  use: {
    baseURL: firstRunBaseUrl,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "first-run",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev --workspace @worthline/web -- --port ${firstRunPort}`,
    url: firstRunBaseUrl,
    reuseExistingServer: false,
    env: {
      WORTHLINE_DB_PATH: firstRunDbPath,
    },
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
