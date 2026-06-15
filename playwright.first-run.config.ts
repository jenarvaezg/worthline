/**
 * Playwright config for the first-run onboarding specs.
 *
 * Runs one first-run scenario per invocation, in complete isolation from the
 * main serial journey: its own throwaway SQLite file and its own Next.js dev
 * server on a separate port, so /empezar is reachable (no workspace exists yet
 * → no redirect to /). The package script runs solo and hogar sequentially
 * because Next dev allows only one server per app directory at a time.
 *
 * To run:
 *   npm run test:e2e:first-run
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FirstRunScenario = "solo" | "hogar";

function resolveFirstRunScenario(value: string | undefined): FirstRunScenario {
  if (!value || value === "hogar") return "hogar";
  if (value === "solo") return "solo";
  throw new Error(`Unsupported FIRST_RUN_SCENARIO=${value}`);
}

const firstRunScenario = resolveFirstRunScenario(process.env.FIRST_RUN_SCENARIO);
const firstRunSpec =
  firstRunScenario === "solo" ? /first-run-solo\.spec\.ts/ : /first-run-hogar\.spec\.ts/;
const defaultFirstRunPort = firstRunScenario === "solo" ? 3003 : 3002;
const firstRunDbDir = mkdtempSync(
  join(tmpdir(), `worthline-first-run-${firstRunScenario}-`),
);
const firstRunDbPath = join(firstRunDbDir, "test.sqlite");
const firstRunPort = Number(process.env.FIRST_RUN_PORT ?? defaultFirstRunPort);
const firstRunBaseUrl = `http://127.0.0.1:${firstRunPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: firstRunSpec,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: `playwright-report-first-run-${firstRunScenario}` },
    ],
  ],
  use: {
    baseURL: firstRunBaseUrl,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: `first-run-${firstRunScenario}`,
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
