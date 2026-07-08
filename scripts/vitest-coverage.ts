/** Enforced in CI via `npm run test:coverage` (issue #732). */
export const vitestCoverage = {
  provider: "v8" as const,
  reporter: ["text-summary"],
  thresholds: {
    lines: 60,
    branches: 50,
    functions: 60,
    statements: 60,
  },
};
