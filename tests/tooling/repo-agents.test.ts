import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The agents defined in `.claude/agents/` are the one part of `.claude/` git
 * tracks, and the subagent canon (`docs/agents/subagents.md`, #1622) sets three
 * rules for them that nothing else enforces:
 *
 * - each one registers itself in the canon, or the main thread never learns it
 *   exists and falls back to the global agent it was written to replace;
 * - none of them can write: a frontmatter without `tools` inherits every tool,
 *   `Write` and `Edit` included, so the list has to be explicit;
 * - a reviewer points at the canon instead of pasting it (#1625): the stack it
 *   names is the one this repo runs, and the front canon is cited, not copied.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = join(REPO_ROOT, ".claude/agents");
const CANON = readFileSync(join(REPO_ROOT, "docs/agents/subagents.md"), "utf8");

const WRITING_TOOLS = ["Write", "Edit", "NotebookEdit"];

type RepoAgent = { body: string; file: string; name?: string; tools?: string[] };

/** Top-level `key: value` lines of the frontmatter; nested blocks are skipped. */
function frontmatterField(source: string, key: string): string | undefined {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  return frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

const agents: RepoAgent[] = readdirSync(AGENTS_DIR)
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => {
    const source = readFileSync(join(AGENTS_DIR, file), "utf8");
    return {
      body: source,
      file,
      name: frontmatterField(source, "name"),
      tools: frontmatterField(source, "tools")
        ?.split(",")
        .map((tool) => tool.trim()),
    };
  });

const agent = (name: string) => {
  const found = agents.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`.claude/agents/ has no agent named ${name}`);
  return found;
};

describe("repo agents (#1622, #1625)", () => {
  test("every agent is named after its file", () => {
    expect(agents.length).toBeGreaterThan(0);
    for (const { file, name } of agents) {
      expect(`${name}.md`).toBe(file);
    }
  });

  test("every agent is registered in the subagent canon", () => {
    const unregistered = agents
      .filter(({ file }) => !CANON.includes(`](../../.claude/agents/${file})`))
      .map(({ file }) => file);

    expect(unregistered).toEqual([]);
  });

  test("no agent can write: its tools are listed and none of them edits", () => {
    const offenders = agents.flatMap(({ file, tools }) => {
      if (!tools) return [`${file}: no tools line, so it inherits Write and Edit`];
      return tools
        .filter((tool) => WRITING_TOOLS.includes(tool))
        .map((tool) => `${file}: ${tool}`);
    });

    expect(offenders).toEqual([]);
  });

  test("wl-db-reviewer speaks libsql/Turso, never the stack of the generic it replaces", () => {
    const { body } = agent("wl-db-reviewer");

    expect(body).not.toMatch(/postgre|supabase/i);
    expect(body).toMatch(/libsql/i);
    expect(body).toMatch(/turso/i);
  });

  test("the canon vetoes database-reviewer and names wl-db-reviewer in its place", () => {
    const vetoRow = CANON.split("\n").find((line) =>
      line.startsWith("| `database-reviewer`"),
    );

    expect(vetoRow).toBeDefined();
    expect(vetoRow).toContain("wl-db-reviewer");
  });

  test("front-reviewer cites both front canon documents and copies neither", () => {
    const { body } = agent("front-reviewer");

    expect(body).toContain("docs/design-system.md");
    expect(body).toContain("docs/interaction-patterns.md");
    // The token table is the first thing a copy would carry: a hex literal in the
    // agent means a value that will go stale the day globals.css changes it.
    expect(body).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});
