/**
 * Authz seam guardian (PRD #998 S3, #1009; retained-capability refactor #1123).
 *
 * The acceptance gate of the authorization seam. Sure's negative lesson was that
 * authorization checked endpoint-by-endpoint drifts: one new surface forgets the
 * check and opens the raw store. This guardian turns "no surface may open a
 * workspace store on its own" into an EXECUTABLE contract, the same shape as the
 * `design-system-guardian` / the #828 test-guardián: the build goes red here the
 * moment a request-reachable module reaches for the raw store opener instead of
 * going through the authorization port (`principal.ts`).
 *
 * The raw openers (`createWorthlineStoreUnsafe`, `withStoreUnsafe`) open a store
 * with NO principal. Since #1123 they are OFF the public `@worthline/db` barrel
 * (asserted below) and reachable only through the deliberately-named internal
 * subpath `@worthline/db/unsafe-store` — so an ordinary importer of the barrel
 * cannot get them by accident. This walk enforces the rest: among request-
 * reachable modules, the port is the ONLY one allowed to import that subpath.
 *
 * Out of the tripwire by design (documented in `principal.ts`): operational
 * scripts (`scripts/**`) and e2e specs (`e2e/**`) — never request-reachable —
 * and unit tests (which seed stores directly). The walk covers the whole web
 * app (`apps/web/**`, so a raw open in `middleware`/`proxy`/`instrumentation`
 * is caught too, not just under `app/`) plus the package sources it consumes,
 * and skips `*.test.*`; `scripts/` and `e2e/` lie outside the walked roots.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as db from "@worthline/db";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const webRoot = join(import.meta.dirname, "..");

/** Build output / tooling / vendored dirs the surface walk must never descend. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "public", "test-results"]);

/** The deliberately-unsafe raw store openers. */
const RAW_OPENERS = ["createWorthlineStoreUnsafe", "withStoreUnsafe"] as const;

/** The single module authorized to wrap the raw opener (the authorization port). */
const PORT = "apps/web/app/principal.ts";

/**
 * The raw openers a source reaches for through a module link to the persistence
 * package. Comments are stripped first, so a module that merely *names* an opener
 * in prose (as the RSC and REST seams do, explaining why they no longer import
 * it) is clean. A file is flagged only when it BOTH links to the package — the
 * public barrel `@worthline/db` OR the internal `@worthline/db/unsafe-store`
 * subpath, via an `import`/`export … from`, so a lone prose mention does not
 * count — AND references an opener identifier, which catches every reach: named
 * (`import { withStoreUnsafe }`), namespaced (`import * as db … db.create…()`),
 * and re-exported (`export { createWorthlineStoreUnsafe } from …`). Matching the
 * bare barrel too keeps the gate red even if a future change re-adds the openers
 * to the public entrypoint. Empty array = passes.
 */
export function rawOpenerImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const linksToDb =
    /(?:import|export)\b[^;]*?from\s*["']@worthline\/db(?:\/unsafe-store)?["']/.test(
      code,
    );
  if (!linksToDb) return [];
  return RAW_OPENERS.filter((opener) => new RegExp(`\\b${opener}\\b`).test(code));
}

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip build output, vendored, and any dot-dir (.turbo/.vercel/.omc/…).
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
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

describe("authz seam guardian · only the port opens the raw store (#1009, #1123)", () => {
  test("the raw openers are OFF the public @worthline/db barrel (#1123)", () => {
    const publicExports = new Set(Object.keys(db));
    for (const opener of RAW_OPENERS) {
      expect(
        publicExports.has(opener),
        `${opener} must not be on the public barrel`,
      ).toBe(false);
    }
  });

  const packagesDirectory = join(repoRoot, "packages");
  const sources = [
    ...walkSourceFiles(webRoot),
    ...walkSourceFiles(join(packagesDirectory, "db/src")),
    ...walkSourceFiles(join(packagesDirectory, "domain/src")),
    ...walkSourceFiles(join(packagesDirectory, "pricing/src")),
  ];
  const relativeSources = new Set(sources.map(relativePath));

  test.each(
    sources,
  )("reaches the store through the port, not the raw opener: %s", (filePath) => {
    const rel = relativePath(filePath);
    const found = rawOpenerImports(readFileSync(filePath, "utf8"));
    if (rel === PORT) return; // the port is the ONE authorized importer.
    expect(
      found,
      `${rel} must open its store through the authorization port (@web/principal), not import ${found.join(", ")} from @worthline/db(/unsafe-store)`,
    ).toEqual([]);
  });

  test("the port is the single authorized importer of the raw opener", () => {
    const port = readFileSync(join(repoRoot, PORT), "utf8");
    expect(rawOpenerImports(port)).toContain("createWorthlineStoreUnsafe");
  });

  // A `test.each([])` passes vacuously: a broken walk (renamed dir, bad
  // `import.meta.dirname`) would go green while checking nothing. Pin a floor
  // and assert the actual surfaces are in scope, so the gate cannot silently
  // stop guarding.
  test("the walk actually covers the surfaces it claims to guard", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const surface of [
      PORT,
      "apps/web/app/store.ts", // RSC seam
      "apps/web/app/agent-view/agent-view-store.ts", // REST seam
      "apps/web/app/api/mcp/route.ts", // MCP surface
      "apps/web/app/api/cron/snapshot/daily-capture-deps.ts", // cron surface
      "apps/web/proxy.ts", // reachable code OUTSIDE app/ (the broadened root)
      "packages/db/src/store-opener.ts", // where the raw opener is defined
    ]) {
      expect(relativeSources.has(surface), `${surface} must be in the walk`).toBe(true);
    }
  });

  // Intentional red case: prove the detector actually catches a bypass, so a
  // green suite means "no surface bypasses" — never "the check is vacuous". Both
  // the internal subpath and the (defensive) bare barrel must trip it.
  test("detects a surface that bypasses the port (intentional red case)", () => {
    expect(
      rawOpenerImports(
        `import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";\n` +
          `export const leak = () => createWorthlineStoreUnsafe();`,
      ),
    ).toEqual(["createWorthlineStoreUnsafe"]);

    expect(
      rawOpenerImports(
        `import { withStoreUnsafe, type WorthlineStore } from "@worthline/db/unsafe-store";`,
      ),
    ).toEqual(["withStoreUnsafe"]);

    // Defensive: a re-add to the bare public barrel is a bypass too.
    expect(rawOpenerImports(`export { withStoreUnsafe } from "@worthline/db";`)).toEqual([
      "withStoreUnsafe",
    ]);

    // Namespaced and re-exported reaches are bypasses too — the detector must
    // not be fooled by the import shape.
    expect(
      rawOpenerImports(
        `import * as db from "@worthline/db/unsafe-store";\nexport const leak = () => db.createWorthlineStoreUnsafe();`,
      ),
    ).toEqual(["createWorthlineStoreUnsafe"]);
  });

  // The opposite guard: naming an opener in prose, or importing only its type,
  // must NOT trip the guardian — else the seams could not document themselves.
  test("prose mentions and type-only imports are not a bypass", () => {
    expect(
      rawOpenerImports(
        `// whose withStoreUnsafe defaults to the local file path (from "@worthline/db/unsafe-store")\n` +
          `/* createWorthlineStoreUnsafe opens with no principal */\n` +
          `import { withAuthorizedStore } from "@web/principal";`,
      ),
    ).toEqual([]);

    expect(
      rawOpenerImports(`import type { WorthlineStore } from "@worthline/db";`),
    ).toEqual([]);
  });
});
