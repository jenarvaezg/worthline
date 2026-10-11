import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The agent docs tell reviewers to read the issue — the **claim** of the briefing in
 * `docs/agents/subagents.md` — before judging a diff. `gh issue view <n> --comments`
 * looks like the way to do it and is not: piped, as every agent runs it, `gh` prints
 * the comments only, never the body, and an issue with no comments prints nothing
 * at all with exit 0. Reviewers got `(Bash completed with no output)` and either
 * re-ran it by hand or reviewed the diff without its spec.
 *
 * The command that reads the whole issue is `--json title,body,labels,comments`.
 * This guard keeps `--comments` from coming back into the docs agents read.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `gh issue view` with `--comments` inside the same code span or line. */
const COMMENTS_ONLY_READ = /gh issue view[^`\n]*--comments/;

const markdownFilesIn = (dir: string): string[] =>
  readdirSync(join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));

const agentFacingDocs = [
  ...markdownFilesIn("docs/agents"),
  ...markdownFilesIn(".claude/agents"),
  join(REPO_ROOT, "AGENTS.md"),
  join(REPO_ROOT, "CONTRIBUTING.md"),
].sort();

describe("agent docs read the whole issue", () => {
  test("no doc reads an issue with `gh issue view --comments`", () => {
    const offenders: string[] = [];

    for (const file of agentFacingDocs) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (COMMENTS_ONLY_READ.test(line)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${index + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});
