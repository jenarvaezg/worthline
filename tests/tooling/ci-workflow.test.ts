import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml"),
  "utf8",
);

function jobNamed(name: string): string {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Job ${name} not found`);

  const rest = workflow.slice(start + marker.length);
  const nextMatch = rest.match(/\n  [a-z][\w-]*:/);
  const end =
    nextMatch?.index === undefined
      ? workflow.length
      : start + marker.length + nextMatch.index;

  return workflow.slice(start, end);
}

describe("ci workflow", () => {
  test("replaces the monolithic quality job with parallel fast-checks, unit-tests, and build jobs", () => {
    expect(workflow).not.toMatch(/^\s+quality:/m);
    expect(workflow).toMatch(/^\s+fast-checks:/m);
    expect(workflow).toMatch(/^\s+unit-tests:/m);
    expect(workflow).toMatch(/^\s+build:/m);
  });

  test("fast-checks runs typecheck, lint, and glob integrity only", () => {
    const job = jobNamed("fast-checks");
    expect(job).toContain("bun run typecheck");
    expect(job).toContain("bun run lint");
    expect(job).toContain("bun run test:globs");
    expect(job).not.toContain("test:coverage");
    expect(job).not.toContain("bun run build");
    expect(job).toContain("bun install --frozen-lockfile");
  });

  test("unit-tests job runs coverage only", () => {
    const job = jobNamed("unit-tests");
    expect(job).toContain("bun run test:coverage");
    expect(job).not.toContain("bun run typecheck");
    expect(job).not.toContain("bun run lint");
    expect(job).not.toContain("bun run build");
    expect(job).toContain("bun install --frozen-lockfile");
  });

  test("build job runs build only", () => {
    const job = jobNamed("build");
    expect(job).toContain("bun run build");
    expect(job).not.toContain("test:coverage");
    expect(job).not.toContain("bun run typecheck");
    expect(job).toContain("bun install --frozen-lockfile");
  });

  test("split jobs do not wait on each other", () => {
    for (const name of ["fast-checks", "unit-tests", "build"] as const) {
      expect(jobNamed(name)).not.toMatch(/^\s+needs:/m);
    }
  });

  test("fast-checks caches Turbo and Biome", () => {
    const job = jobNamed("fast-checks");
    expect(job).toContain("path: .turbo");
    expect(job).toContain("path: ~/.cache/biome");
  });
});
