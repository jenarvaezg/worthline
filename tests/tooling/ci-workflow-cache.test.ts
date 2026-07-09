import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml"),
  "utf8",
);

function jobBlock(jobKey: string): string {
  const marker = `\n  ${jobKey}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Job ${jobKey} not found`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.search(/\n  [a-z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

describe("CI workflow local caches (#799)", () => {
  test("fast-checks job caches Turbo and Biome with lockfile-driven keys", () => {
    const fastChecks = jobBlock("fast-checks");

    expect(fastChecks).toContain("path: .turbo");
    expect(fastChecks).toContain("hashFiles('bun.lock', 'turbo.json')");
    expect(fastChecks).toContain("path: ~/.cache/biome");
    expect(fastChecks).toContain("hashFiles('bun.lock', 'biome.json')");
  });

  test("unit-tests and build jobs cache Turbo only", () => {
    for (const jobKey of ["unit-tests", "build"] as const) {
      const job = jobBlock(jobKey);
      expect(job).toContain("path: .turbo");
      expect(job).toContain("hashFiles('bun.lock', 'turbo.json')");
      expect(job).not.toContain("path: ~/.cache/biome");
    }
  });

  test("e2e-setup job caches Turbo for the production build step", () => {
    const e2eSetup = jobBlock("e2e-setup");

    expect(e2eSetup).toContain("path: .turbo");
    expect(e2eSetup).toContain("hashFiles('bun.lock', 'turbo.json')");
    expect(e2eSetup).not.toContain("path: ~/.cache/biome");
  });
});
