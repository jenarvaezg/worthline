import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const ciWorkflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml"),
  "utf8",
);

const deployWorkflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/deploy.yml"),
  "utf8",
);

describe("Turbo Remote Cache in CI workflows", () => {
  test("ci.yml wires Vercel remote cache env and routes e2e build through turbo", () => {
    expect(ciWorkflow).toContain("TURBO_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(ciWorkflow).toContain("TURBO_TEAM: ${{ vars.TURBO_TEAM }}");
    expect(ciWorkflow).toContain("bunx turbo run build --filter=@worthline/web");
  });

  test("deploy.yml wires Vercel remote cache env", () => {
    expect(deployWorkflow).toContain("TURBO_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(deployWorkflow).toContain("TURBO_TEAM: ${{ vars.TURBO_TEAM }}");
  });
});
