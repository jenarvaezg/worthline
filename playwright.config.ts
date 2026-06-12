/**
 * Playwright e2e configuration for worthline.
 *
 * DB isolation design:
 *   One throwaway SQLite file per `npm run test:e2e` invocation, placed in
 *   a temporary directory that is discarded after the run. Tests are run
 *   serially (workers: 1) so they share a single Next.js dev server instance
 *   and a single DB file, building state incrementally in journey order.
 *   This matches the "one DB per run, serial journey" design described in #61.
 *
 * To run:
 *   npm run test:e2e
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One temporary DB file per process invocation — discarded when the OS cleans
// up the temp dir. Never touches the developer's real data.
const e2eDbDir = mkdtempSync(join(tmpdir(), "worthline-e2e-"));
const e2eDbPath = join(e2eDbDir, "test.sqlite");

// Overridable so concurrent checkouts (e.g. agent worktrees) can run the suite
// side by side without colliding on the same port.
const e2ePort = Number(process.env.E2E_PORT ?? 3001);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

// Expose the DB path so the globalSetup script can seed a historical snapshot
// before the webServer boots (the decomposition legend needs ≥2 calendar days).
process.env.WORTHLINE_DB_PATH = e2eDbPath;

export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  testDir: "./e2e",
  // Serial: one worker, no parallelism. All tests share the same server + DB.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eBaseUrl,
    // Server-rendered HTML — no JS navigation, so we wait for full page loads.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    // Don't carry browser state across test files (each spec gets a fresh context).
    // Within a spec, state is shared so journey steps build on each other.
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // next dev reads --port from CLI args; pass it explicitly so it doesn't
    // collide with the developer's default :3000 server.
    command: `npm run dev --workspace @worthline/web -- --port ${e2ePort}`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    env: {
      WORTHLINE_DB_PATH: e2eDbPath,
    },
    // Give Next.js up to 60s to start on first cold run.
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
