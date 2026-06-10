import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app tsconfig uses `jsx: "preserve"` (Next.js transforms JSX itself),
  // so the test transform must compile JSX explicitly for .tsx tests.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
    ],
  },
});
