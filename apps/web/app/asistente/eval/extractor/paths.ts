import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BalanceSeriesGoldenFixture, GoldenFixture } from "./manifest";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "../../../../../..");
const LOCAL_ROOT = join(REPO_ROOT, ".local/extractor-golden");

export function extractorEvalRoot(): string {
  return MODULE_DIR;
}

export function localExtractorGoldenRoot(): string {
  return LOCAL_ROOT;
}

function rootFor(storage: "committed" | "local"): string {
  return storage === "committed" ? MODULE_DIR : LOCAL_ROOT;
}

export function resolveFixtureImagePath(fixture: GoldenFixture): string {
  return join(rootFor(fixture.storage), fixture.imageFile);
}

export function resolveFixtureExpectedPath(fixture: GoldenFixture): string {
  return join(rootFor(fixture.storage), fixture.expectedFile);
}

export function resolveBalanceSeriesSourcePath(
  fixture: BalanceSeriesGoldenFixture,
): string {
  return join(rootFor(fixture.storage), fixture.sourceFile);
}

export function resolveBalanceSeriesExpectedPath(
  fixture: BalanceSeriesGoldenFixture,
): string {
  return join(rootFor(fixture.storage), fixture.expectedFile);
}
