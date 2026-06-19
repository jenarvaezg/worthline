import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #361 guardrail: once the alias migration (#355–#360) removed every upward
// relative import, this pattern stops them from creeping back. It matches any
// specifier that starts with `../` (at any depth, in import/export/dynamic
// import) and leaves same-directory `./…` imports alone. Reach other zones
// through their alias (@web/@domain/@db/@pricing) and cross workspace packages
// through the public @worthline/* boundary.
const noUpwardRelativeImport = {
  regex: "^\\.\\./",
  message:
    "Upward relative imports are banned (#361). Use a zone alias — @web/@domain/@db/@pricing for app/package source, @tests/@e2e/@scripts for those zones — or the @worthline/* package boundary. Same-directory ./… imports are still fine.",
};

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
    // #361 guardrail (see noUpwardRelativeImport). Scoped to the zones the root
    // `lint` script covers (apps, packages, tests). NOTE: e2e/ and scripts/ are
    // not part of the root lint path, so the rule is not enforced there yet —
    // they currently have zero upward imports; widening the lint path to cover
    // them is a separate follow-up.
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noUpwardRelativeImport] }],
    },
  },
  {
    // R14 guardrail: domain sub-modules must import from leaf files, never from
    // the barrel (./index). Importing the barrel from within domain reintroduces
    // the circular dependencies that R13/R14 eliminated. Tests are exempt because
    // they legitimately exercise the public API surface via the barrel.
    //
    // This block is intentionally ordered AFTER the #361 block above: ESLint flat
    // config REPLACES (does not merge) a rule's options per file, so for domain
    // source — which both blocks match — this one wins and must therefore carry
    // BOTH restrictions (the upward-import ban and the barrel ban).
    files: ["packages/domain/src/**/*.ts"],
    ignores: ["packages/domain/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noUpwardRelativeImport,
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
