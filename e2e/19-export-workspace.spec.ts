/**
 * Journey 19: Export workspace to a downloadable JSON file (issue #102).
 *
 * Runs after 18-reset-workspace, which leaves the shared serial DB with NO
 * workspace — so this journey bootstraps its own state through the real UI:
 * solo onboarding, one asset, then downloads the export from /ajustes and
 * asserts the document's shape.
 */

import { readFileSync } from "node:fs";

import { test, expect, addHolding } from "./fixtures";

interface ExportDocument {
  version: number;
  assets: Array<{ name: string }>;
  [section: string]: unknown;
}

test("export workspace: bootstrap via UI → Exportar downloads the JSON document", async ({
  page,
}) => {
  // 1. Spec 18 wiped the DB → the app redirects to onboarding.
  await page.goto("/");
  await expect(page).toHaveURL(/empezar/);

  // 2. Complete the solo onboarding (same interactions as journey 01).
  await expect(page.getByRole("heading", { name: "Empezar solo" })).toBeVisible();
  await page.getByLabel("Tu nombre").fill("ExportUser");
  await page.getByRole("button", { name: "Empezar solo" }).click();
  // First run chains into the add wizard (S4, #599), not the dashboard.
  await expect(page).toHaveURL("/patrimonio/anadir");

  // 3. Create one asset through the real form (same as journey 03).
  await addHolding(page, {
    instrument: "current_account",
    name: "Cuenta Export",
    value: "5000",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // 4. The Exportar affordance is visible in /ajustes.
  await page.goto("/ajustes");
  const exportLink = page.getByRole("link", { name: "Exportar" });
  await expect(exportLink).toBeVisible();

  // 5. Clicking it downloads the export file (Content-Disposition attachment).
  const downloadPromise = page.waitForEvent("download");
  await exportLink.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(
    /^worthline-export-\d{4}-\d{2}-\d{2}\.json$/,
  );

  // 6. The downloaded document is the versioned export with every section.
  const downloadPath = await download.path();
  const doc = JSON.parse(readFileSync(downloadPath, "utf8")) as ExportDocument;

  expect(doc.version).toBe(2);
  for (const section of [
    "workspace",
    "members",
    "assets",
    "snapshots",
    "trash",
    "priceCache",
  ]) {
    expect(doc, `export document is missing the "${section}" section`).toHaveProperty(
      section,
    );
  }

  // 7. The asset created through the UI is in the assets section.
  expect(doc.assets.map((asset) => asset.name)).toContain("Cuenta Export");
});
