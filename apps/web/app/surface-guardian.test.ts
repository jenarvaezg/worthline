/**
 * Surface guardian (#1014): workspace code must not write exposure profiles.
 * After S5, the only writer is admin CRUD on the control plane (S4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const appDirectory = join(import.meta.dirname);
const packagesDirectory = join(repoRoot, "packages");

const FORBIDDEN_PATTERNS = [
  /store\.exposureProfiles\.saveExposureProfile/,
  /store\.exposureProfiles\.deleteExposureProfile/,
  /store\.exposureProfiles\.mergeBreakdowns/,
  /\bcreateExposureProfile\s*\(/,
  /\bcanHandEnterExposureProfile\b/,
  /propose_exposure_profiles/,
  /list_exposure_profile_fill_targets/,
  /saveExposureProfileAction/,
] as const;

/** Paths allowed to reference admin CRUD or import validation (not workspace writes). */
const ALLOWLIST = new Set([
  "packages/db/src/control-plane.ts",
  "packages/db/src/control-plane-migrate.ts",
  "packages/db/tests/control-plane-global-exposure-profile.persistence.test.ts",
  "packages/domain/src/global-exposure-profile.ts",
  "packages/domain/src/global-exposure-profile.test.ts",
  "packages/domain/src/workspace-transfer-parse.ts",
  "packages/domain/src/exposure-lookthrough.ts",
  "packages/db/src/workspace-store.ts",
  "apps/web/app/surface-guardian.test.ts",
]);

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

describe("surface guardian · exposure profile writes (#1014)", () => {
  const sources = [
    ...walkSourceFiles(appDirectory),
    ...walkSourceFiles(join(packagesDirectory, "db/src")),
    ...walkSourceFiles(join(packagesDirectory, "domain/src")),
  ];

  test.each(sources)("no workspace write symbols in %s", (filePath) => {
    const rel = relativePath(filePath);
    if (ALLOWLIST.has(rel)) return;

    const source = readFileSync(filePath, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(source, `${rel} must not match ${pattern}`).not.toMatch(pattern);
    }
  });
});
