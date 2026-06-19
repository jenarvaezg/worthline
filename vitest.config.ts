import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Zone-alias contract (#355). The runner is the single source of truth for
// resolving the zone aliases at test time — it covers app tests, package tests,
// AND root tests uniformly. Array form (with a regex `find`) anchors each alias
// at the start of the specifier so prefixes never collide, and maps to ABSOLUTE
// paths so resolution is independent of the test file's location. Cross-package
// imports stay on the `@worthline/*` package boundary and are NOT aliased here.
const zone = (dir: string) => fileURLToPath(new URL(dir, import.meta.url));

export default defineConfig({
  // The app tsconfig uses `jsx: "preserve"` (Next.js transforms JSX itself),
  // so the test transform must compile JSX explicitly for .tsx tests.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [
      { find: /^@web\//, replacement: `${zone("apps/web/app")}/` },
      { find: /^@domain\//, replacement: `${zone("packages/domain/src")}/` },
      { find: /^@db\//, replacement: `${zone("packages/db/src")}/` },
      { find: /^@pricing\//, replacement: `${zone("packages/pricing/src")}/` },
      { find: /^@tests\//, replacement: `${zone("tests")}/` },
      { find: /^@e2e\//, replacement: `${zone("e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("scripts")}/` },
    ],
  },
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
    ],
  },
});
