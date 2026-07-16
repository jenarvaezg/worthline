import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const { vitestCoverage } = require(
  fileURLToPath(new URL("../../scripts/vitest-coverage.ts", import.meta.url)),
);

const zone = (dir: string) => fileURLToPath(new URL(dir, import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [
      { find: /^@web\//, replacement: `${zone("../../apps/web/app")}/` },
      { find: /^@domain\//, replacement: `${zone("../../packages/domain/src")}/` },
      { find: /^@db\//, replacement: `${zone("src")}/` },
      { find: /^@pricing\//, replacement: `${zone("../../packages/pricing/src")}/` },
      { find: /^@tests\//, replacement: `${zone("../../tests")}/` },
      { find: /^@e2e\//, replacement: `${zone("../../e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("../../scripts")}/` },
    ],
  },
  test: {
    environment: "node",
    // src/**: co-located unit tests (the *-store / seam-module specs) run in CI
    // alongside the tests/** persistence suite. Without this, src-local *.test.ts
    // are collected only by the root config (dev/`test:watch`), never by
    // `turbo run test` (CI), so their assertions never gated a merge.
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    // Every db test spins up a FULLY-MIGRATED libsql store (`createWorthlineStoreUnsafe`
    // runs the whole migration ladder against a temp file) — a few seconds each on
    // its own. Under `test:coverage` (v8 instrumentation) on a 2-core CI runner,
    // heavy export/import round-trips tip past Vitest's 5s default and flake by
    // timeout even though nothing is hung. 30s absorbs the coverage tax while still
    // catching a genuine hang. (These are slow-but-not-hung by construction.)
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: vitestCoverage,
  },
});
