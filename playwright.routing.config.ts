/**
 * Playwright config for auth-gated route migration tests (#949).
 *
 * Enables the sign-in wall (dummy AUTH_GOOGLE_*) without real OAuth so we can
 * assert redirect targets and returnTo validation. No DB seeding — these specs
 * only exercise HTTP redirects and the public /login surface.
 *
 *   npx playwright test --config playwright.routing.config.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const routingPort = Number(process.env.ROUTING_PORT ?? 3005);
const routingBaseUrl = `http://127.0.0.1:${routingPort}`;

const routingDbPath = join(
  mkdtempSync(join(tmpdir(), "worthline-routing-e2e-")),
  "test.sqlite",
);

const isCI = !!process.env.CI;

export default defineConfig({
  tsconfig: "./tsconfig.e2e.json",
  testDir: "./e2e",
  testMatch: /route-migration-auth\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-routing" }],
  ],
  use: {
    baseURL: routingBaseUrl,
    actionTimeout: isCI ? 20_000 : 10_000,
    navigationTimeout: isCI ? 30_000 : 15_000,
    trace: "on-first-retry",
  },
  projects: [{ name: "routing", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: isCI
      ? `bun run --filter @worthline/web start -- --port ${routingPort}`
      : `bun run --filter @worthline/web dev -- --port ${routingPort}`,
    url: routingBaseUrl,
    reuseExistingServer: false,
    env: {
      WORTHLINE_DB_PATH: routingDbPath,
      // Enable the auth gate without real Google credentials.
      AUTH_GOOGLE_ID: "routing-e2e-client-id",
      AUTH_GOOGLE_SECRET: "routing-e2e-client-secret",
      AUTH_SECRET: "worthline-routing-e2e-secret-not-for-production",
      NEXT_PUBLIC_ENABLE_SW: "1",
    },
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
