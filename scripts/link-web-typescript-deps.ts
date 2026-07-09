#!/usr/bin/env node
/**
 * Next.js checks for TypeScript packages under apps/web/node_modules. Bun's
 * hoisted workspace layout can leave stale .bun-store symlinks there after
 * linker changes — relink to the root hoisted copies before `next build`.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webNm = join(repoRoot, "apps/web/node_modules");
const rootNm = join(repoRoot, "node_modules");

const packages = ["typescript", "@types/node", "@types/react", "@types/react-dom"];

function relink(pkg: string) {
  const source = join(rootNm, pkg);
  if (!existsSync(source)) return;

  const dest = join(webNm, pkg);
  mkdirSync(dirname(dest), { recursive: true });

  if (existsSync(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(dest, { recursive: true, force: true });
    }
  }

  const rel = relative(dirname(dest), source);
  symlinkSync(rel, dest);
}

for (const pkg of packages) {
  relink(pkg);
}
