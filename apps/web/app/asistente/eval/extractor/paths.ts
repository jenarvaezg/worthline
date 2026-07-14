import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GoldenFixture } from "./manifest";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = resolve(MODULE_DIR, "../../../../../..", ".local/extractor-golden");

export function extractorEvalRoot(): string {
  return MODULE_DIR;
}

export function localExtractorGoldenRoot(): string {
  return LOCAL_ROOT;
}

export function resolveFixtureImagePath(fixture: GoldenFixture): string {
  return fixture.storage === "committed"
    ? join(MODULE_DIR, fixture.imageFile)
    : join(LOCAL_ROOT, fixture.imageFile);
}

export function resolveFixtureExpectedPath(fixture: GoldenFixture): string {
  return fixture.storage === "committed"
    ? join(MODULE_DIR, fixture.expectedFile)
    : join(LOCAL_ROOT, fixture.expectedFile);
}
