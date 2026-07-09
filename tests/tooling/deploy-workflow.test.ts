import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/deploy.yml"),
  "utf8",
);

function stepNamed(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`Step ${name} not found`);

  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe("deploy workflow", () => {
  test("lets Vercel use its configured app root instead of nesting apps/web twice", () => {
    for (const step of [
      "Pull Vercel project config",
      "Build prebuilt output on Node 26",
      "Deploy prebuilt output to Vercel",
    ]) {
      expect(stepNamed(step)).not.toContain("working-directory: apps/web");
    }
  });
});
