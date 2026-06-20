import { defineConfig } from "vitest/config";

import { sharedVitestConfig } from "./vitest.shared";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
    ],
  },
});
