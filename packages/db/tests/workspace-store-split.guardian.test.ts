/**
 * The seam of #1603: the workspace lifecycle (members, init, reset) and the
 * whole-workspace document (export/import) are two reasons to change, so they
 * are two modules. This pins the direction of that seam — «un cambio de miembro
 * no obliga a revisar el serialize» — by reading each module's imports, which is
 * where a re-entangling actually shows up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const sourceDirectory = join(import.meta.dirname, "../src");

/** Every module specifier the file imports from. */
function importsOf(file: string): string[] {
  const source = readFileSync(join(sourceDirectory, file), "utf8");
  return [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";$/gm)].map(
    (match) => match[1]!,
  );
}

describe("workspace store · lifecycle vs document (#1603)", () => {
  test("the lifecycle module reaches for nothing of the document", () => {
    const specifiers = importsOf("workspace-store.ts");

    expect(specifiers).not.toContain("./workspace-document-store");
    // The document's own vocabulary lives in the domain — serializeWorkspaceExport
    // and the Exported* types. A member write has no business with any of it.
    const source = readFileSync(join(sourceDirectory, "workspace-store.ts"), "utf8");
    expect(source).not.toMatch(/\bserializeWorkspaceExport\b/);
    expect(source).not.toMatch(/\bExported[A-Z]/);
  });

  test("the wipe of the two full-replace paths lives in neither of them", () => {
    for (const file of ["workspace-store.ts", "workspace-document-store.ts"]) {
      expect(importsOf(file), file).toContain("./workspace-tables");
      // Raw SQL is the standing store-rule exception, and it is wipeWorkspaceTables'
      // alone (see StoreContext) — neither half may grow one of its own.
      const source = readFileSync(join(sourceDirectory, file), "utf8");
      expect(source, file).not.toMatch(/client\.execute/);
    }
  });
});
