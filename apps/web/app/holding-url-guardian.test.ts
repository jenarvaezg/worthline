/**
 * Holding-URL guardian (#1318): a holding is named in a URL by its public
 * `wl_hld_…` id and by nothing else.
 *
 * The defect this pins down was not one bad link, it was a second vocabulary:
 * the web addressed a holding by its internal `asset_…`/`liability_…` storage
 * id while every tool the assistant has only accepts the public one. Whatever
 * the user had in the URL bar — and therefore whatever landed in the model's
 * `screenContext` — was the one id no tool would take, so the model ended up
 * asking people to copy ids out of the address bar for a flow that can never
 * work.
 *
 * A single rebuilt template string is enough to bring that back, so the rule is
 * a grep rather than a convention: no source may interpolate anything into a
 * `/patrimonio/…/editar` path or a `/patrimonio#…` fragment. The two href
 * builders in `holding-route.ts` are the only exception, and they take a public
 * id by type.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const appDirectory = join(import.meta.dirname);
const packagesDirectory = join(repoRoot, "packages");

/**
 * A holding URL assembled from a value the guard cannot see: `${...}` in the
 * path segment or the fragment, or the same thing spelled with `+`. The only
 * safe way to build one is `holdingDetailHref` / `holdingBoardHref`, which name
 * their argument.
 *
 * A grep is a tripwire, not a proof — a determined caller can still assemble the
 * string out of variables. It catches the shape the codebase actually had, which
 * is what regressions look like.
 */
const FORBIDDEN_PATTERNS = [
  /`\/patrimonio\/\$\{[^}]*\}\/editar/,
  /`\/patrimonio#\$\{[^}]*\}/,
  // The same thing spelled with concatenation.
  /"\/patrimonio\/"\s*\+/,
  /"\/patrimonio#"\s*\+/,
] as const;

/** The module that owns the two builders — the single place the shape is written. */
const ALLOWLIST = new Set(["apps/web/app/holding-route.ts"]);

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    files.push(fullPath);
  }
  return files;
}

function relativePath(absolute: string): string {
  return absolute.slice(repoRoot.length + 1);
}

describe("holding URL guardian · one id vocabulary (#1318)", () => {
  const sources = [
    ...walkSourceFiles(appDirectory),
    ...walkSourceFiles(join(packagesDirectory, "db/src")),
    ...walkSourceFiles(join(packagesDirectory, "domain/src")),
  ];

  test.each(sources)("no hand-built holding URL in %s", (filePath) => {
    const rel = relativePath(filePath);
    if (ALLOWLIST.has(rel)) return;

    const source = readFileSync(filePath, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(source, `${rel} must build holding URLs via holding-route.ts`).not.toMatch(
        pattern,
      );
    }
  });
});
