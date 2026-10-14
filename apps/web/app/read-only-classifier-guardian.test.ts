/**
 * Read-only classifier guardian (#1843, ADR 0112) — the third guardian of the
 * mutation seam, next to `authz-seam-guardian` (who may open a store) and
 * `write-guard-guardian` (every action passes a guard).
 *
 * The invariant: **`blockedWriteMessage` is the only place that decides whether a
 * session may write.** A target is read-only because it carries one of two
 * markers — `impersonatedEmail` (an admin impersonating, #697) or `sharedByEmail`
 * (a viewer of a shared workspace, #1843) — or because it is the demo. Before this
 * guardian the «demo or impersonating» test was spelled out by hand in six places
 * (the proposal guard, the assistant mount, `/bienvenida`, onboarding twice,
 * feedback), so adding a third reason meant finding every copy — and the one
 * missed would have let a viewer write. Now a module that reads a marker outside
 * the allowlist turns the build red; it must ask the classifier
 * (`blockedWriteMessage`, `actsOnOwnAccount`, `viewsSharedWorkspace`) instead.
 *
 * Allowed, each for a reason:
 *   - `demo/write-guard.ts` — the classifier itself;
 *   - `store-resolver.ts` — declares the markers and sets them on a target;
 *   - `principal.ts` — the port opens a viewer's store read-only (#1842);
 *   - `admin/impersonation-banner.tsx` — the band shows WHOSE workspace it is,
 *     which is the marker's value, not a write decision. The viewer's band (S4,
 *     #1844) joins this list for the same reason.
 *
 * Any mention counts — a property read, a destructuring, an `in` check — once
 * comments are stripped, so prose that names a marker never trips it.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readSourceFiles, stripComments } from "./guardian-walk";

const repoRoot = join(import.meta.dirname, "../../..");
const webRoot = join(import.meta.dirname, "..");

/** The fields whose presence makes an authenticated target read-only. */
const READ_ONLY_MARKERS = ["impersonatedEmail", "sharedByEmail"] as const;

/** The modules allowed to name a marker — see the docblock for each reason. */
const ALLOWED: ReadonlySet<string> = new Set([
  "apps/web/app/demo/write-guard.ts",
  "apps/web/app/store-resolver.ts",
  "apps/web/app/principal.ts",
  "apps/web/app/admin/impersonation-banner.tsx",
]);

/** The read-only markers a source names in code (comments stripped). */
export function readOnlyMarkersNamed(source: string): string[] {
  const code = stripComments(source);
  return READ_ONLY_MARKERS.filter((marker) => new RegExp(`\\b${marker}\\b`).test(code));
}

function relativePath(absolute: string): string {
  return absolute.slice(repoRoot.length + 1);
}

describe("read-only classifier guardian · no copies of blockedWriteMessage (#1843)", () => {
  const sources = readSourceFiles(webRoot).map(({ filePath, source }) => ({
    rel: relativePath(filePath),
    source,
  }));

  test("only the allowlisted modules name a read-only marker", () => {
    const offenders = sources
      .filter(({ rel }) => !ALLOWED.has(rel))
      .map(({ rel, source }) => ({ markers: readOnlyMarkersNamed(source), rel }))
      .filter(({ markers }) => markers.length > 0)
      .map(({ markers, rel }) => `${rel} (${markers.join(", ")})`);

    expect(
      offenders,
      `${offenders.join("; ")} must ask the classifier (blockedWriteMessage / actsOnOwnAccount / viewsSharedWorkspace in demo/write-guard.ts) instead of reading a read-only marker`,
    ).toEqual([]);
  });

  test("every allowlisted module exists and still names a marker (no stale entry)", () => {
    const byPath = new Map(sources.map(({ rel, source }) => [rel, source]));
    for (const rel of ALLOWED) {
      const source = byPath.get(rel);
      expect(source, `${rel} must be in the walk`).toBeDefined();
      expect(
        readOnlyMarkersNamed(source ?? ""),
        `${rel} no longer needs the exemption`,
      ).not.toEqual([]);
    }
  });

  test("the walk covers the web app (not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  // Intentional red cases: the detector catches the copies it exists to forbid.
  test("detects a hand-written copy of the classifier (intentional red case)", () => {
    expect(
      readOnlyMarkersNamed(
        `export function canDoIt(target: StoreTarget) {\n` +
          `  return target.kind === "authenticated" && target.impersonatedEmail === undefined;\n` +
          `}\n`,
      ),
    ).toEqual(["impersonatedEmail"]);
    expect(
      readOnlyMarkersNamed(
        `const { sharedByEmail } = target;\nif (sharedByEmail) return;\n`,
      ),
    ).toEqual(["sharedByEmail"]);
    expect(readOnlyMarkersNamed(`if ("sharedByEmail" in target) return null;\n`)).toEqual(
      ["sharedByEmail"],
    );
  });

  test("a marker named only in a comment does not count", () => {
    expect(
      readOnlyMarkersNamed(
        `// never read target.sharedByEmail here\n/* nor impersonatedEmail */\nexport const x = 1;\n`,
      ),
    ).toEqual([]);
  });
});
