/**
 * Workflow least-privilege guardian (#1180).
 *
 * GitHub's default `GITHUB_TOKEN` permission set is repository-configurable and
 * historically write-all. A workflow that never pushes, never comments and never
 * publishes should say so explicitly at the top, so the token every third-party
 * action inherits cannot write to the repo regardless of the org default.
 *
 * The Turbo remote-cache token is the second half: `TURBO_TOKEN` only needs to
 * read/write the Vercel remote cache, while `VERCEL_TOKEN` can deploy and mutate
 * the whole Vercel project. CI (which runs on every pull request, including from a
 * fork's branch once approved) must not carry the deploy-capable token just to hit
 * a build cache.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const workflowsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);

const WORKFLOWS = ["ci.yml", "deploy.yml"] as const;

function read(name: string): string {
  return readFileSync(join(workflowsDir, name), "utf8");
}

/** The top-level (column-2) block introduced by `key:`, up to the next top-level key. */
function topLevelBlock(workflow: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\n(?:[ \\t].*\\n|\\n)*`, "m").exec(workflow);
  return match?.[0] ?? null;
}

describe("workflow least privilege (#1180)", () => {
  test.each(WORKFLOWS)("%s declares top-level read-only contents permission", (name) => {
    const permissions = topLevelBlock(read(name), "permissions");

    expect(permissions, `${name} must declare a top-level permissions block`).not.toBe(
      null,
    );
    expect(permissions).toContain("contents: read");
    // No write scope may be granted repo-wide; a job that needs one declares it.
    expect(permissions).not.toMatch(/:\s*write/);
  });

  test("ci.yml grants pull-requests: read only where paths-filter needs it", () => {
    const workflow = read("ci.yml");

    // dorny/paths-filter reads the PR's changed files through the API on a
    // `pull_request` event, so the `changes` job needs this one extra read scope.
    // Job-level, not repo-level: no other job gets it.
    const changesJob = workflow.slice(
      workflow.indexOf("  changes:"),
      workflow.indexOf("  fast-checks:"),
    );
    expect(changesJob).toContain("pull-requests: read");
    expect(topLevelBlock(workflow, "permissions")).not.toContain("pull-requests");
  });

  test.each(
    WORKFLOWS,
  )("%s uses a cache-scoped Turbo token, not the deploy-capable VERCEL_TOKEN", (name) => {
    const workflow = read(name);

    expect(workflow).toContain("TURBO_TOKEN: ${{ secrets.TURBO_CACHE_TOKEN");
    // The fallback exists only until the scoped secret is provisioned; the
    // scoped one must come FIRST so it wins as soon as it is set.
    expect(workflow).not.toMatch(/TURBO_TOKEN:\s*\$\{\{\s*secrets\.VERCEL_TOKEN\s*\}\}/);
  });

  test("ci.yml never references VERCEL_TOKEN outside the Turbo cache fallback", () => {
    const workflow = read("ci.yml");
    const references = workflow.match(/secrets\.VERCEL_TOKEN/g) ?? [];

    // CI does not deploy. The only allowed mention is the remote-cache fallback.
    expect(references).toHaveLength(1);
    expect(workflow).toMatch(/TURBO_TOKEN:.*secrets\.VERCEL_TOKEN/);
  });
});
