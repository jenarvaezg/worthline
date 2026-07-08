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
      { find: /^@db\//, replacement: `${zone("../../packages/db/src")}/` },
      { find: /^@pricing\//, replacement: `${zone("src")}/` },
      { find: /^@tests\//, replacement: `${zone("../../tests")}/` },
      { find: /^@e2e\//, replacement: `${zone("../../e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("../../scripts")}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: vitestCoverage,
  },
});
