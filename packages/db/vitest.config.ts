import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
  },
});
