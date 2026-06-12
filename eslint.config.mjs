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
