/**
 * The source walk the repo's test-guardians share (#1180).
 *
 * `authz-seam-guardian`, `write-guard-guardian` and the `app-cookie` tripwire all
 * need the same thing: every non-test `.ts`/`.tsx` under a root, skipping build
 * output and vendored trees. Each had grown its own byte-identical copy, which is
 * how a guardian quietly stops guarding — one copy gains a skip rule, the others
 * do not, and their walks silently diverge.
 *
 * Lives under `app/` (not a test-only folder) so the guardians can import it by
 * the `@web/` alias like anything else; it has no dependencies and is inert at
 * runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Build output / tooling / vendored dirs no guardian walk may descend. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "public", "test-results"]);

/**
 * Every non-test TypeScript source under `root`, recursively. Dot-directories
 * (`.turbo`, `.vercel`, `.next` variants, worktrees) are skipped along with
 * {@link SKIP_DIRECTORIES}, and `*.test.ts`/`*.test.tsx` are excluded — a
 * guardian checks production surfaces, and its own red-case fixtures must not
 * trip it.
 */
export function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    files.push(fullPath);
  }
  return files;
}

/** Strip block and line comments, so a guardian never matches prose. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Whether this source is a module-level `"use server"` action module.
 *
 * Comments are stripped FIRST, which is the whole point: Next allows comments
 * before the directive, and this repo's house style is a leading docblock. A
 * naive `/^\s*"use server";/` would drop exactly the most likely new action file
 * from the walk and fail open — a guardian that passes by not looking.
 */
export function isServerActionModule(source: string): boolean {
  return /^\s*"use server";/.test(stripComments(source));
}

/** Read every source under `root` once, paired with its path. */
export function readSourceFiles(
  root: string,
): Array<{ filePath: string; source: string }> {
  return walkSourceFiles(root).map((filePath) => ({
    filePath,
    source: readFileSync(filePath, "utf8"),
  }));
}
