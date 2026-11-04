import { existsSync, readFileSync } from "node:fs";

import type { FixtureManifestEntry } from "@pricing/myinvestor/fixtures/capture-plan";

/**
 * The MyInvestor fixtures (#1887): `capture/` is anonymized from real responses by
 * `bun run fixtures:myinvestor`, `synthetic/` is written by hand for what the real
 * account does not have. Each folder has a `manifest.json` that says which request every
 * body answers. See `README.md` and the skill `.claude/skills/myinvestor-fixtures/`.
 */
const url = (path: string) => new URL(path, import.meta.url);
const read = (path: string) => readFileSync(url(path), "utf8");

function manifest(folder: "capture" | "synthetic"): FixtureManifestEntry[] {
  // `capture/` only exists once the anonymized captures are committed.
  if (!existsSync(url(`${folder}/manifest.json`))) return [];
  return JSON.parse(read(`${folder}/manifest.json`)) as FixtureManifestEntry[];
}

export const MYINVESTOR_FIXTURES: readonly FixtureManifestEntry[] = [
  ...manifest("capture"),
  ...manifest("synthetic"),
];

/** A fixture body, parsed. `file` is the manifest's, relative to this folder. */
export function readMyInvestorFixture(file: string): unknown {
  return JSON.parse(read(file));
}

/** The text of a fixture, for checks that must see the literals as written. */
export function readMyInvestorFixtureText(file: string): string {
  return read(file);
}

/** The folder of the fixtures, for the guard that scans every file in it. */
export const MYINVESTOR_FIXTURES_DIR = url(".");
