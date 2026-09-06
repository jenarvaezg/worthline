/**
 * Page-name guardian (#1706): every `page.tsx` default export carries a name of
 * its own.
 *
 * Next only needs *a* default export from a `page.tsx`, so two routes exporting
 * `AnadirHoldingPage` (`/patrimonio/anadir` and `/patrimonio/anadir/avanzado` did)
 * compile, render and pass every test — and then a stack trace, a React
 * devtools tree or a symbol search names one and means the other. The rule is
 * therefore about the name declared AT the export site — the one a route is
 * searched for and printed as. An anonymous `export default function () {}` has
 * none, and `export default Content` puts the name somewhere else in the file,
 * so both are held to the same rule.
 *
 * The scan is textual and reads that declared name, so it sees what the export
 * line itself says. It does not follow a `const Page = …; export default Page`
 * indirection; this suite does not write that shape, and the day it does the
 * rule belongs here.
 */
import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { readSourceFiles, stripComments } from "./guardian-walk";

/** A route page and the name its default export is declared under. */
type PageExport = { filePath: string; name: string };

/** The name a page's default export is declared under; `null` when it has none. */
export function defaultExportName(source: string): string | null {
  const match = stripComments(source).match(
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  );
  return match?.[1] ?? null;
}

/** Every name more than one page declares, with the pages that share it. */
export function duplicateDefaultExportNames(
  pages: readonly PageExport[],
): Array<{ name: string; files: string[] }> {
  const claims = new Map<string, string[]>();
  for (const { filePath, name } of pages) {
    claims.set(name, [...(claims.get(name) ?? []), filePath]);
  }
  return [...claims.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files }));
}

/** Every route page under `app/`, with its declared default export name. */
function readPages(): Array<{ filePath: string; name: string | null }> {
  return readSourceFiles(import.meta.dirname)
    .filter(({ filePath }) => basename(filePath) === "page.tsx")
    .map(({ filePath, source }) => ({
      filePath: filePath.slice(import.meta.dirname.length + 1),
      name: defaultExportName(source),
    }));
}

describe("page-name guardian (#1706)", () => {
  test("the walk sees the route pages (it is not silently empty)", () => {
    expect(readPages().length).toBeGreaterThan(20);
  });

  test("every page declares a named default export", () => {
    const anonymous = readPages()
      .filter(({ name }) => name === null)
      .map(({ filePath }) => filePath);

    expect(
      anonymous,
      "declare the page as `export default function <Route>Page` so a stack trace " +
        "can name it (#1706)",
    ).toEqual([]);
  });

  test("no two pages share a default export name", () => {
    const named = readPages().filter((page): page is PageExport => page.name !== null);
    const offenders = duplicateDefaultExportNames(named).map(
      ({ name, files }) => `${name}: ${files.join(", ")}`,
    );

    expect(
      offenders,
      "a page's default export is how stack traces and symbol searches name the " +
        "route; give each route its own (#1706)",
    ).toEqual([]);
  });

  describe("the scan itself", () => {
    test("reads a sync or async named default export", () => {
      expect(defaultExportName("export default function HomePage() {}")).toBe("HomePage");
      expect(defaultExportName("export default async function AjustesPage() {}")).toBe(
        "AjustesPage",
      );
    });

    test("treats an anonymous or re-exported default as unnamed", () => {
      expect(defaultExportName("export default function () {}")).toBeNull();
      expect(defaultExportName("export default Content;")).toBeNull();
    });

    test("ignores a default export named only in prose", () => {
      expect(
        defaultExportName("/** export default function GhostPage */\nconst a = 1;"),
      ).toBeNull();
    });

    test("names the shared export and every page declaring it", () => {
      expect(
        duplicateDefaultExportNames([
          { filePath: "a/page.tsx", name: "AnadirHoldingPage" },
          { filePath: "a/b/page.tsx", name: "AnadirHoldingPage" },
          { filePath: "c/page.tsx", name: "CPage" },
        ]),
      ).toEqual([{ name: "AnadirHoldingPage", files: ["a/page.tsx", "a/b/page.tsx"] }]);
    });
  });
});
