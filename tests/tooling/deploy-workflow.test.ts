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
  test("builds and deploys the prebuilt Vercel artifact from the web app root", () => {
    for (const step of [
      "Pull Vercel project config",
      "Build prebuilt output on Node 24",
      "Deploy prebuilt output to Vercel",
    ]) {
      expect(stepNamed(step)).toContain("working-directory: apps/web");
    }
  });
});
