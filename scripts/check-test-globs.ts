/**
 * Fail CI when a `*.test.ts(x)` file lives outside its workspace vitest `include`
 * glob — otherwise `turbo run test` silently skips it (issue #732).
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type WorkspaceCheck = {
  name: string;
  root: string;
  includes: string[];
};

const WORKSPACES: WorkspaceCheck[] = [
  { name: "@worthline/web", root: "apps/web", includes: ["app/**/*.test.{ts,tsx}"] },
  {
    name: "@worthline/db",
    root: "packages/db",
    includes: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
  {
    name: "@worthline/domain",
    root: "packages/domain",
    includes: ["src/**/*.test.{ts,tsx}"],
  },
  {
    name: "@worthline/pricing",
    root: "packages/pricing",
    includes: ["src/**/*.test.{ts,tsx}"],
  },
  { name: "@worthline/tests", root: "tests", includes: ["**/*.test.{ts,tsx}"] },
];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

function expandBraceGlob(pattern: string): string[] {
  const match = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!match) return [pattern];
  const [, pre, alts, post] = match;
  return alts.split(",").map((alt) => `${pre}${alt}${post}`);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += ".";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${re}$`);
}

function matchesGlob(pattern: string, posixPath: string): boolean {
  return expandBraceGlob(pattern).some((expanded) =>
    globToRegExp(expanded).test(posixPath),
  );
}

function walkTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkTestFiles(full));
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

const orphans: string[] = [];

for (const workspace of WORKSPACES) {
  const absRoot = join(repoRoot, workspace.root);
  for (const file of walkTestFiles(absRoot)) {
    const rel = relative(absRoot, file).replaceAll("\\", "/");
    const matched = workspace.includes.some((pattern) => matchesGlob(pattern, rel));
    if (!matched) {
      orphans.push(
        `${workspace.name}: ${rel} (not matched by ${workspace.includes.join(" nor ")})`,
      );
    }
  }
}

if (orphans.length > 0) {
  console.error("Test files outside their package vitest include glob:\n");
  for (const orphan of orphans) {
    console.error(`  - ${orphan}`);
  }
  console.error(
    "\nBroaden the workspace vitest `include` or move the test file so CI collects it.",
  );
  process.exit(1);
}

console.log("All workspace test files match their vitest include globs.");
