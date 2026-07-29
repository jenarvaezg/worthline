import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Guardián del hueco de #1274: `bun run typecheck` es `turbo run typecheck`, o
 * sea el task de cada workspace, y el árbol `e2e/` no es un workspace — su
 * tsconfig es `tsconfig.e2e.json`, que solo lee Playwright, y Playwright compila
 * con esbuild, que borra tipos en vez de comprobarlos. Sin un script propio
 * encadenado en «Fast checks», ningún job de CI typechequea los specs e2e (así
 * sobrevivió una violación viva del invariante admin-only de #1123).
 *
 * Estas aserciones fijan las tres piezas del gate: el script existe, apunta al
 * tsconfig del árbol e2e, y el job que ya corre typecheck · lint · globs lo
 * ejecuta.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const packageJson = JSON.parse(source("package.json")) as {
  scripts: Record<string, string>;
};
const workflow = source(".github/workflows/ci.yml");
const tsconfigE2e = source("tsconfig.e2e.json");

function jobNamed(name: string): string {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Job ${name} not found`);

  const rest = workflow.slice(start + marker.length);
  const nextMatch = rest.match(/\n  [a-z][\w-]*:/);
  const end =
    nextMatch?.index === undefined
      ? workflow.length
      : start + marker.length + nextMatch.index;

  return workflow.slice(start, end);
}

describe("e2e typecheck gate (#1274)", () => {
  test("root exposes a typecheck:e2e script pointed at tsconfig.e2e.json", () => {
    const script = packageJson.scripts["typecheck:e2e"];
    expect(script).toBeDefined();
    expect(script).toContain("--noEmit");
    expect(script).toContain("tsconfig.e2e.json");
  });

  test("fast-checks runs the e2e typecheck alongside the workspace one", () => {
    const job = jobNamed("fast-checks");
    // Terminadas en salto de línea a propósito: `toContain("bun run typecheck")`
    // lo satisface la subcadena dentro de `bun run typecheck:e2e`, así que no
    // detectaría que alguien borrase el paso de workspaces.
    expect(job).toContain("run: bun run typecheck\n");
    expect(job).toContain("run: bun run typecheck:e2e\n");
  });

  test("verify chains the e2e typecheck so local runs match CI", () => {
    expect(packageJson.scripts.verify).toContain("typecheck:e2e");
  });

  test("tsconfig.e2e.json covers every playwright config, not just the default", () => {
    expect(tsconfigE2e).toContain("playwright.config.ts");
    expect(tsconfigE2e).toContain("playwright.*.config.ts");
  });

  // El invariante admin-only de #1123 NO se re-vigila aquí por grep: con el gate
  // de arriba en su sitio, pedir la escritura de curación desde el store estrecho
  // es un error de tipos en CI — que es justo lo que #1123 quería, «unrepresentable
  // by type» y no meramente grep-detectable.
});
