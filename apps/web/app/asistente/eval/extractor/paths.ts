import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GoldenFixture } from "./manifest";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "../../../../../..");
const LOCAL_ROOT = join(REPO_ROOT, ".local/extractor-golden");

export function extractorEvalRoot(): string {
  return MODULE_DIR;
}

export function localExtractorGoldenRoot(): string {
  return LOCAL_ROOT;
}

function resolveFixtureFile(fixture: GoldenFixture, file: string): string {
  const root = fixture.storage === "committed" ? MODULE_DIR : LOCAL_ROOT;
  return join(root, file);
}

export function resolveFixtureImagePath(fixture: GoldenFixture): string {
  return resolveFixtureFile(fixture, fixture.imageFile);
}

export function resolveFixtureExpectedPath(fixture: GoldenFixture): string {
  return resolveFixtureFile(fixture, fixture.expectedFile);
}
