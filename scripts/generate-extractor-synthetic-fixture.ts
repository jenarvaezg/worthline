/**
 * Render the committed synthetic broker table to PNG for the extractor golden set.
 *
 *   bun scripts/generate-extractor-synthetic-fixture.ts
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = join(
  ROOT,
  "apps/web/app/asistente/eval/extractor/fixtures/synthetic-baseline.html",
);
const PNG_PATH = join(
  ROOT,
  "apps/web/app/asistente/eval/extractor/fixtures/synthetic-baseline.png",
);

async function main(): Promise<void> {
  mkdirSync(dirname(PNG_PATH), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { height: 640, width: 820 },
    });
    await page.goto(`file://${HTML_PATH}`);
    await page.locator(".frame").screenshot({ path: PNG_PATH, type: "png" });
  } finally {
    await browser.close();
  }
  console.error(`Wrote ${PNG_PATH}`);
}

void main();
