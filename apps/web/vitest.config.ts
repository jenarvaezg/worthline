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
      // The workspace routes live in the `(workspace)` route group (#1190); these
      // specific aliases MUST precede the generic `@web/` so `@web/<route>/*`
      // imports still resolve. First match wins in vite's alias array.
      { find: /^@web\/app\//, replacement: `${zone("app/(workspace)/app")}/` },
      {
        find: /^@web\/patrimonio\//,
        replacement: `${zone("app/(workspace)/patrimonio")}/`,
      },
      {
        find: /^@web\/historico\//,
        replacement: `${zone("app/(workspace)/historico")}/`,
      },
      {
        find: /^@web\/objetivos\//,
        replacement: `${zone("app/(workspace)/objetivos")}/`,
      },
      { find: /^@web\/ajustes\//, replacement: `${zone("app/(workspace)/ajustes")}/` },
      { find: /^@web\/premium\//, replacement: `${zone("app/(workspace)/premium")}/` },
      { find: /^@web\//, replacement: `${zone("app")}/` },
      { find: /^@domain\//, replacement: `${zone("../../packages/domain/src")}/` },
      { find: /^@db\//, replacement: `${zone("../../packages/db/src")}/` },
      { find: /^@pricing\//, replacement: `${zone("../../packages/pricing/src")}/` },
      { find: /^@tests\//, replacement: `${zone("../../tests")}/` },
      { find: /^@e2e\//, replacement: `${zone("../../e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("../../scripts")}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
    coverage: vitestCoverage,
  },
});
