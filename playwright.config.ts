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

// One temporary DB file for the WHOLE run — discarded when the OS cleans up the
// temp dir. Never touches the developer's real data. Playwright re-imports this
// config in the main runner AND in every worker process, so the path must be
// computed once and shared: we carry it through a dedicated internal env var
// (set by the main process, inherited by workers) rather than mkdtemp-ing per
// import. Without this, a worker would create a fresh empty DB and a spec that
// opens the store directly (e.g. seeding a price, journey 32) would not see the
// data the webServer wrote. We key off our OWN var, never the public
// WORTHLINE_DB_PATH, so a developer's pre-set WORTHLINE_DB_PATH can never make
// the suite run against real data.
const e2eDbPath =
  process.env.WORTHLINE_E2E_DB_PATH ??
  join(mkdtempSync(join(tmpdir(), "worthline-e2e-")), "test.sqlite");
process.env.WORTHLINE_E2E_DB_PATH = e2eDbPath;

// Overridable so concurrent checkouts (e.g. agent worktrees) can run the suite
// side by side without colliding on the same port.
const e2ePort = Number(process.env.E2E_PORT ?? 3001);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

// A stand-alone fake Binance + CoinGecko server (e2e/fake-binance-server.mjs) the
// Next.js process is pointed at for the Binance journey (#252): the connect/sync
// fetches run SERVER-side, which page.route() can't stub, so we override the
// pricing base URLs to this local server instead. The +901 offset keeps it clear
// of THIS run's Next port and the dev :3000 in the default single-checkout case;
// concurrent checkouts must give each a well-spaced E2E_PORT (or set E2E_FAKE_PORT
// explicitly) — a clash binds loudly (EADDRINUSE) at startup, never silently.
const fakeApiPort = Number(process.env.E2E_FAKE_PORT ?? e2ePort + 901);
const fakeApiBaseUrl = `http://127.0.0.1:${fakeApiPort}`;

// In CI we run against a PRODUCTION build (`next start`) instead of `next dev`.
// `next dev` compiles routes on demand, and the dashboard `/` route is heavy
// enough that the first compile on a (slower) CI runner overran the 15s
// navigation timeout — flaky by construction. `next start` serves precompiled
// routes, so request latency is small and deterministic. The CI workflow runs
// `next build` for the web app before invoking Playwright so `.next` exists.
const isCI = !!process.env.CI;

// Expose the DB path so the globalSetup script can seed a historical snapshot
// before the webServer boots (the decomposition legend needs ≥2 calendar days).
process.env.WORTHLINE_DB_PATH = e2eDbPath;

export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  testDir: "./e2e",
  testIgnore: /first-run.*\.spec\.ts/,
  // Serial: one worker, no parallelism. All tests share the same server + DB.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eBaseUrl,
    // Server-rendered HTML — no JS navigation, so we wait for full page loads.
    actionTimeout: isCI ? 20_000 : 10_000,
    navigationTimeout: isCI ? 30_000 : 15_000,
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
  webServer: [
    // The fake Binance + CoinGecko server — started before Next.js so the signed
    // server-side fetches in the Binance journey hit deterministic stubs.
    {
      command: `node ./e2e/fake-binance-server.mjs`,
      url: `${fakeApiBaseUrl}/__health`,
      reuseExistingServer: false,
      env: { FAKE_PORT: String(fakeApiPort) },
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // next dev/start read --port from CLI args; pass it explicitly so they
      // don't collide with the developer's default :3000 server. In CI we serve
      // the production build (precompiled routes → deterministic latency).
      command: isCI
        ? `npm run start --workspace @worthline/web -- --port ${e2ePort}`
        : `npm run dev --workspace @worthline/web -- --port ${e2ePort}`,
      url: e2eBaseUrl,
      reuseExistingServer: false,
      env: {
        WORTHLINE_DB_PATH: e2eDbPath,
        // Point the Binance + CoinGecko clients at the fake server (#252).
        WORTHLINE_BINANCE_BASE_URL: fakeApiBaseUrl,
        WORTHLINE_COINGECKO_BASE_URL: `${fakeApiBaseUrl}/coingecko/api/v3`,
      },
      // Give Next.js up to 60s to start on first cold run.
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
