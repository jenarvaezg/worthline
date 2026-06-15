/**
 * Journey 20: Import workspace — validate and atomically full-replace (#103),
 * through the preview → confirm flow (#104).
 *
 * Self-sufficient: if the shared DB has no workspace yet (fresh server), the
 * spec completes solo onboarding via the real UI first. It then guarantees
 * pre-existing data by creating an asset, imports a valid export document from
 * the danger zone (preview, then confirm — full replace, lands on the
 * dashboard), and finally verifies that an invalid file (wrong version) is
 * rejected at the PREVIEW step — inline error, no confirm button offered —
 * while leaving the workspace untouched.
 */

import { test, expect, addHolding } from "./fixtures";

/** A valid version-2 export document, built inline (plain object literal). */
const importedDoc = {
  version: 2,
  workspace: { mode: "individual", baseCurrency: "EUR" },
  members: [{ id: "member-ana-importada", name: "Ana Importada" }],
  assets: [
    {
      id: "asset-cuenta-importada",
      name: "Cuenta importada",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 4242400, currency: "EUR" },
      liquidityTier: "cash",
      isPrimaryResidence: false,
      ownership: [{ memberId: "member-ana-importada", shareBps: 10000 }],
    },
  ],
};

test("import replaces the whole workspace; an invalid file changes nothing", async ({
  page,
}) => {
  // ── Self-sufficient setup: onboard via the real UI when the DB is fresh ──
  await page.goto("/");

  if (page.url().includes("/empezar")) {
    await expect(page.getByRole("heading", { name: "Empezar solo" })).toBeVisible();
    await page.getByLabel("Tu nombre").fill("TestUser");
    await page.getByRole("button", { name: "Empezar solo" }).click();
    await expect(page).toHaveURL("/");
  }

  // Guarantee pre-existing data: create one asset through the UI.
  await addHolding(page, {
    instrument: "current_account",
    name: "Activo preexistente 20",
    value: "1234",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("cell", { name: "Activo preexistente 20" })).toBeVisible();

  // ── Happy path: preview, then confirm, in the danger zone ────────────────
  await page.goto("/ajustes");
  const dangerZone = page.getByRole("region", { name: "Zona de peligro" });
  await dangerZone.locator('input[name="file"]').setInputFiles({
    name: "worthline-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(importedDoc)),
  });
  await dangerZone.getByRole("button", { name: "Ver contenido del archivo" }).click();

  // The preview shows the file's content summary before anything is written.
  await expect(dangerZone.getByText("1 miembro", { exact: true })).toBeVisible();
  await expect(dangerZone.getByText("1 activo", { exact: true })).toBeVisible();

  // Confirm: the same form (same chosen file) posts to the import action.
  await dangerZone.getByRole("button", { name: "Importar y reemplazar" }).click();

  // Lands on the dashboard — never onboarding.
  await expect(page).toHaveURL("/");

  // The imported asset replaced the pre-existing one.
  await page.goto("/patrimonio");
  await expect(page.getByRole("cell", { name: "Cuenta importada" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Activo preexistente 20" }),
  ).not.toBeVisible();

  // ── Failure path: a wrong-version file is rejected at the preview step ───
  await page.goto("/ajustes");
  await dangerZone.locator('input[name="file"]').setInputFiles({
    name: "bad-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...importedDoc, version: 99 })),
  });
  await dangerZone.getByRole("button", { name: "Ver contenido del archivo" }).click();

  // Inline error, clear and specific — and no confirm button is offered.
  await expect(
    dangerZone.getByRole("alert").filter({ hasText: "No se puede importar" }),
  ).toContainText("versión 99");
  await expect(
    dangerZone.getByRole("button", { name: "Importar y reemplazar" }),
  ).not.toBeVisible();
  await expect(page).toHaveURL(/\/ajustes/);

  // The previously imported workspace is fully intact.
  await page.goto("/patrimonio");
  await expect(page.getByRole("cell", { name: "Cuenta importada" })).toBeVisible();
});
