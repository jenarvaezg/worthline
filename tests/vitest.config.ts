import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const { vitestCoverage } = require(
  fileURLToPath(new URL("../scripts/vitest-coverage.ts", import.meta.url)),
);

const zone = (dir: string) => fileURLToPath(new URL(dir, import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [
      { find: /^@web\//, replacement: `${zone("../apps/web/app")}/` },
      { find: /^@domain\//, replacement: `${zone("../packages/domain/src")}/` },
      { find: /^@db\//, replacement: `${zone("../packages/db/src")}/` },
      { find: /^@pricing\//, replacement: `${zone("../packages/pricing/src")}/` },
      { find: /^@tests\//, replacement: `${zone(".")}/` },
      { find: /^@e2e\//, replacement: `${zone("../e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("../scripts")}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    // The persistence-heavy wiring suite saturates the local SQLite/libSQL
    // workers when Vitest fans out to every CPU: unrelated 5s tests then time
    // out at random. Four workers keeps the suite parallel and deterministic.
    maxWorkers: 4,
    coverage: vitestCoverage,
  },
});
