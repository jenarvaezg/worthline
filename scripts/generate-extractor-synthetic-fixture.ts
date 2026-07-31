/**
 * Render the committed synthetic captures to PNG for the extractor golden set.
 *
 *   bun scripts/generate-extractor-synthetic-fixture.ts                      # all
 *   bun scripts/generate-extractor-synthetic-fixture.ts synthetic-baseline   # a subset
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "apps/web/app/asistente/eval/extractor/fixtures");

interface SyntheticFixtureRender {
  id: string;
  viewport: { height: number; width: number };
}

/**
 * The viewport each committed capture is rendered at. The resulting PNG size is pinned
 * separately, next to the golden set that grades it, in
 * `apps/web/app/asistente/eval/extractor/synthetic-fixtures.ts` — a script under
 * `scripts/` cannot import across zones (#361), and the two are different facts anyway:
 * this is the render input, that is the committed artifact's contract.
 */
const SYNTHETIC_FIXTURE_RENDERS: readonly SyntheticFixtureRender[] = [
  { id: "synthetic-baseline", viewport: { height: 640, width: 820 } },
  { id: "synthetic-payment-screen", viewport: { height: 760, width: 420 } },
  { id: "synthetic-amortization-schedule", viewport: { height: 560, width: 760 } },
  { id: "synthetic-value-only-composition", viewport: { height: 720, width: 420 } },
];

function selectFixtures(ids: readonly string[]): readonly SyntheticFixtureRender[] {
  if (ids.length === 0) return SYNTHETIC_FIXTURE_RENDERS;
  const known = SYNTHETIC_FIXTURE_RENDERS.map((fixture) => fixture.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown synthetic fixture id(s): ${unknown.join(", ")}. ` +
        `Known: ${known.join(", ")}.`,
    );
  }
  return SYNTHETIC_FIXTURE_RENDERS.filter((fixture) => ids.includes(fixture.id));
}

async function main(): Promise<void> {
  const fixtures = selectFixtures(process.argv.slice(2));
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const fixture of fixtures) {
      const htmlPath = join(FIXTURES_DIR, `${fixture.id}.html`);
      const pngPath = join(FIXTURES_DIR, `${fixture.id}.png`);
      const page = await browser.newPage({ viewport: fixture.viewport });
      try {
        await page.goto(`file://${htmlPath}`);
        await page.locator(".frame").screenshot({ path: pngPath, type: "png" });
      } finally {
        await page.close();
      }
      console.error(`Wrote ${pngPath}`);
    }
  } finally {
    await browser.close();
  }
}

void main();
