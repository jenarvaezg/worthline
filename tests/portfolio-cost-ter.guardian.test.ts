/**
 * The TER never enters a return (#1717, ADR 0109).
 *
 * A fund's net asset value is already net of its ongoing charges, so a
 * rentabilidad that subtracted the TER would charge it twice. Naming the returns
 * modules and forbidding them the TER cannot hold that line — a returns module can
 * be called anything (`benchmark-comparison`, `fire-*`, a web view model), and the
 * one written tomorrow is not on any list. So the rule is turned around: two
 * CLOSED lists say who may touch the TER at all, and every other production file
 * in the repo is refused.
 *
 * - **Cost consumers** — the files that reach the portfolio-cost lens: they name
 *   one of its exports (`portfolioCost`, `PortfolioCost…`, whatever it exports
 *   tomorrow) or import its module by path, statically or with a dynamic
 *   `import()`. Naming the symbol is what catches the barrel: `@worthline/domain`
 *   re-exports everything, so an import graph alone would say every web file
 *   reaches the lens.
 * - **TER readers** — the files that mention a `ter` field at all: the catalog
 *   that stores it, the profile that validates it, the admin that edits it, the
 *   agent view that shows it, and the lens that prices it.
 *
 * A file that joins either set fails this test until someone adds it here on
 * purpose — which is the moment to ask whether it is computing a return. A file
 * that leaves a set fails too, so neither list rots into a stale allowance.
 *
 * Textual, like the repo's other guardians: comments are stripped so prose never
 * matches, and an aliased re-export under another name would slip through. The
 * shapes it misses are not ones this codebase writes; the day one appears, the fix
 * is here.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments, walkSourceFiles } from "@web/guardian-walk";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const COST_LENS = "packages/domain/src/portfolio-cost.ts";

/** Every production `.ts`/`.tsx` of the repo: the app, every package, the scripts. */
const SCANNED_ROOTS = ["apps", "packages", "scripts"];

/** The files allowed to reach the portfolio-cost lens. */
const COST_CONSUMERS = [
  "apps/web/app/(workspace)/patrimonio/exposure-section.tsx",
  "apps/web/app/(workspace)/patrimonio/load-patrimonio.ts",
  "apps/web/app/(workspace)/patrimonio/page.tsx",
  "apps/web/app/(workspace)/patrimonio/portfolio-cost-view.ts",
  "packages/domain/src/index.ts",
];

/** The files allowed to mention a `ter` field. */
const TER_READERS = [
  // The admin edits it (ADR 0058: the catalog is admin-curated).
  "apps/web/app/admin/catalogo/actions.ts",
  "apps/web/app/admin/catalogo/catalog-profile-editor.tsx",
  "apps/web/app/admin/catalogo/catalog-triage.ts",
  "apps/web/app/admin/catalogo/catalog-workbench.tsx",
  // The agent view shows a security's profile as a fact, never as a figure.
  "apps/web/app/agent-view/contract/exposure.ts",
  "apps/web/app/agent-view/holding-detail.ts",
  // The control plane stores it; the migrations define its column.
  "packages/db/src/control-plane/exposure-profile-catalog.ts",
  "packages/db/src/control-plane/migrate.ts",
  "packages/db/src/migrate.ts",
  // The domain validates it, carries it on the profile and maps it to the lens.
  "packages/domain/src/exposure-identity.ts",
  "packages/domain/src/exposure-lookthrough.ts",
  "packages/domain/src/global-exposure-profile.ts",
  // The one consumer that does arithmetic with it.
  COST_LENS,
];

interface ScannedFile {
  path: string;
  code: string;
}

function productionFiles(): ScannedFile[] {
  return SCANNED_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
    .map((fullPath) => ({
      code: stripComments(readFileSync(fullPath, "utf8")),
      path: relative(REPO_ROOT, fullPath),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The lens's exported names, read from the lens — so a new export is guarded too. */
function costLensExports(): string[] {
  const code = readFileSync(join(REPO_ROOT, COST_LENS), "utf8");
  return [
    ...code.matchAll(
      /export\s+(?:async\s+)?(?:function|interface|type|const|class)\s+(\w+)/g,
    ),
  ].map((match) => match[1] as string);
}

function reachesCostLens(code: string, exportNames: readonly string[]): boolean {
  const namesTheLens = new RegExp(`\\b(?:${exportNames.join("|")})\\b`);
  // Any specifier ending in `/portfolio-cost` — `./`, `@domain/`, `../src/` —
  // whether after `from`, a bare `import` or inside a dynamic `import(...)`.
  const importsTheModule = /["'`](?:[^"'`]*\/)?portfolio-cost(?:\.ts)?["'`]/;
  return namesTheLens.test(code) || importsTheModule.test(code);
}

function readsTer(code: string): boolean {
  return /\bter\b/.test(code);
}

const files = productionFiles();

describe("the TER never enters a return (#1717, ADR 0109)", () => {
  test("the walk sees the domain, the web app and the lens itself", () => {
    // Without these the closed lists below would pass vacuously over nothing.
    const paths = files.map((file) => file.path);
    expect(paths).toContain(COST_LENS);
    expect(paths).toContain("packages/domain/src/returns.ts");
    expect(paths).toContain("apps/web/app/agent-view/returns.ts");
    expect(costLensExports()).toContain("portfolioCost");
  });

  test("only the closed list of consumers reaches the portfolio-cost lens", () => {
    const exportNames = costLensExports();
    const consumers = files
      .filter((file) => file.path !== COST_LENS)
      .filter((file) => reachesCostLens(file.code, exportNames))
      .map((file) => file.path);

    expect(consumers).toEqual([...COST_CONSUMERS].sort());
  });

  test("only the closed list of readers mentions a `ter` field", () => {
    const readers = files.filter((file) => readsTer(file.code)).map((file) => file.path);

    expect(readers).toEqual([...TER_READERS].sort());
  });

  test("the detectors see a dynamic import and a bracket read", () => {
    // The two shapes a hurried returns module would reach for.
    expect(
      reachesCostLens('const lens = await import("@domain/portfolio-cost");', ["x"]),
    ).toBe(true);
    expect(
      reachesCostLens('const { portfolioCost } = await import("@worthline/domain");', [
        "portfolioCost",
      ]),
    ).toBe(true);
    expect(readsTer('const fee = profile["ter"];')).toBe(true);
    expect(readsTer("const charter = 1;")).toBe(false);
  });
});
