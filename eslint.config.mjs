import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  {
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  ...nextVitals,
  ...nextTs,
  {
    // R14 guardrail: domain sub-modules must import from leaf files, never from
    // the barrel (./index). Importing the barrel from within domain reintroduces
    // the circular dependencies that R13/R14 eliminated. Tests are exempt because
    // they legitimately exercise the public API surface via the barrel.
    files: ["packages/domain/src/**/*.ts"],
    ignores: ["packages/domain/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./index", "./index.ts"],
              message:
                "Domain sub-modules must import from leaf files, not the barrel (./index). See R14 / PRD #120.",
            },
          ],
        },
      ],
    },
  },
  {
    // Playwright fixtures take a `use` callback —
    // `base.extend({ page: async ({ page }, use) => … })`. The react-hooks plugin
    // (pulled in by next/core-web-vitals) misreads the `use(...)` call as a React
    // Hook. e2e specs are not React components, so the rule does not apply here.
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".local/**",
    "**/.next/**",
    "**/.local/**",
    "coverage/**",
    "**/coverage/**",
    "dist/**",
    "**/dist/**",
    "node_modules/**",
    "**/node_modules/**",
    "out/**",
    "**/out/**",
  ]),
]);
