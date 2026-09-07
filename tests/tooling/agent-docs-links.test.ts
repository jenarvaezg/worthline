import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The subagent canon (#1622) tells agents to *point* at the canonical document
 * instead of pasting it, because duplicated canon goes stale exactly where nobody
 * looks. That method is only as good as the pointers: a doc that gets moved or
 * renamed leaves a link that silently resolves to nothing, and the agent following
 * it reads no canon at all rather than stale canon.
 *
 * This guard walks every relative Markdown link under `docs/agents/` and fails the
 * gate when one no longer lands on a file. Offenders are collected and compared
 * against `[]` so the report names each broken pointer instead of stopping at the
 * first.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT_DOCS_DIR = join(REPO_ROOT, "docs/agents");

/** `[text](target)` — the target is what has to exist on disk. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Absolute URLs and bare anchors point at something other than a repo file. */
const isRelativePath = (target: string) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#");

const markdownFilesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

const agentDocs = markdownFilesIn(AGENT_DOCS_DIR);

describe("agent docs (#1622)", () => {
  test("docs/agents holds Markdown", () => {
    expect(agentDocs.length).toBeGreaterThan(0);
  });

  test("every relative Markdown link resolves to a file", () => {
    const broken: string[] = [];

    for (const file of agentDocs) {
      const body = readFileSync(file, "utf8");
      for (const [, target] of body.matchAll(MARKDOWN_LINK)) {
        if (!isRelativePath(target)) continue;

        // `page.md#section` addresses a heading inside the file; only the path
        // part has to exist.
        const path = target.split("#")[0];
        if (path === "") continue;

        if (existsSync(resolve(dirname(file), path))) continue;
        broken.push(`${file.slice(REPO_ROOT.length + 1)} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });

  test("AGENTS.md points at the subagent canon", () => {
    // The canon is only reachable because the root instructions name it: an agent
    // that never learns it exists falls back to the global defaults it vetoes.
    const rootInstructions = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

    expect(existsSync(join(AGENT_DOCS_DIR, "subagents.md"))).toBe(true);
    expect(rootInstructions).toContain("docs/agents/subagents.md");
  });
});
