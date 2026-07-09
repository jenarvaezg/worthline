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
  test("quality job caches Turbo and Biome with lockfile-driven keys", () => {
    const quality = jobBlock("quality");

    expect(quality).toContain("path: .turbo");
    expect(quality).toContain("hashFiles('bun.lock', 'turbo.json')");
    expect(quality).toContain("path: ~/.cache/biome");
    expect(quality).toContain("hashFiles('bun.lock', 'biome.json')");
  });

  test("e2e job caches Turbo for the production build step", () => {
    const e2e = jobBlock("e2e");

    expect(e2e).toContain("path: .turbo");
    expect(e2e).toContain("hashFiles('bun.lock', 'turbo.json')");
    expect(e2e).not.toContain("path: ~/.cache/biome");
  });
});
