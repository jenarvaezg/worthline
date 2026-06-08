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
