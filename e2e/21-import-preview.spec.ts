/**
 * Journey 21: Import preview — content summary and data-loss warning before
 * confirm (#104).
 *
 * Self-sufficient: onboards via the real UI if the DB is fresh and guarantees
 * pre-existing data by creating an asset. Then, in the /ajustes danger zone:
 * a valid file's preview shows the per-section content summary (papelera
 * included), the data-loss warning with the export-first reminder, and only
 * then a confirm button; an invalid file (wrong version) shows a clear inline
 * error and offers NO confirm button. This journey never confirms an import.
 */

import { test, expect } from "./fixtures";

/** A valid version-1 export document with known per-section counts. */
const previewDoc = {
  version: 1,
  workspace: { mode: "household", baseCurrency: "EUR" },
  members: [
    { id: "member-preview-1", name: "Preview Uno" },
    { id: "member-preview-2", name: "Preview Dos" },
  ],
  assets: [
    {
      id: "asset-preview-1",
      name: "Cuenta preview",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 100000, currency: "EUR" },
      liquidityTier: "cash",
      isPrimaryResidence: false,
      ownership: [{ memberId: "member-preview-1", shareBps: 10000 }],
    },
  ],
  trash: {
    assets: [
      {
        id: "asset-preview-trashed",
        name: "Activo en papelera",
        type: "manual",
        currency: "EUR",
        currentValue: { amountMinor: 50000, currency: "EUR" },
        liquidityTier: "illiquid",
        ownership: [{ memberId: "member-preview-1", shareBps: 10000 }],
        deletedAt: "2026-05-20T12:00:00.000Z",
      },
    ],
    liabilities: [],
  },
};

test("import preview: summary + data-loss warning for a valid file; inline error and no confirm for an invalid one", async ({
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
  await page.goto("/patrimonio/nuevo-activo");
  await expect(page.getByRole("heading", { name: "Nuevo activo" })).toBeVisible();
  await page.getByLabel("Nombre del activo").fill("Activo preexistente 21");
  await page.getByLabel("Valor actual en EUR").fill("777");
  await page.getByRole("button", { name: "Añadir activo" }).click();
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("cell", { name: "Activo preexistente 21" })).toBeVisible();

  // ── Valid file: preview shows summary, warning, reminder, then confirm ──
  await page.goto("/ajustes");
  const dangerZone = page.getByRole("region", { name: "Zona de peligro" });

  // No confirm button exists before any preview.
  await expect(
    dangerZone.getByRole("button", { name: "Importar y reemplazar" }),
  ).not.toBeVisible();

  await dangerZone.locator('input[name="file"]').setInputFiles({
    name: "worthline-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(previewDoc)),
  });
  await dangerZone.getByRole("button", { name: "Ver contenido del archivo" }).click();

  // Content summary, per section — papelera included.
  await expect(dangerZone.getByText("2 miembros", { exact: true })).toBeVisible();
  await expect(dangerZone.getByText("1 activo", { exact: true })).toBeVisible();
  await expect(dangerZone.getByText("0 pasivos", { exact: true })).toBeVisible();
  await expect(dangerZone.getByText("0 operaciones", { exact: true })).toBeVisible();
  await expect(dangerZone.getByText("0 snapshots", { exact: true })).toBeVisible();
  await expect(
    dangerZone.getByText("Papelera: 1 activo y 0 pasivos", { exact: true }),
  ).toBeVisible();

  // Data-loss warning + reminder to export the current workspace first.
  await expect(
    dangerZone.getByText("se reemplazará por completo y se perderá", { exact: false }),
  ).toBeVisible();
  const exportReminder = dangerZone.getByRole("link", { name: "Exportar" });
  await expect(exportReminder).toBeVisible();
  await expect(exportReminder).toHaveAttribute("href", "/ajustes/export");

  // Only now is the confirm button offered.
  await expect(
    dangerZone.getByRole("button", { name: "Importar y reemplazar" }),
  ).toBeVisible();

  // ── Picking a different file resets the stale preview ────────────────────
  await dangerZone.locator('input[name="file"]').setInputFiles({
    name: "bad-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...previewDoc, version: 99 })),
  });
  await expect(
    dangerZone.getByRole("button", { name: "Importar y reemplazar" }),
  ).not.toBeVisible();

  // ── Invalid file (version 99): clear inline error, no confirm offered ────
  await dangerZone.getByRole("button", { name: "Ver contenido del archivo" }).click();

  await expect(
    dangerZone.getByRole("alert").filter({ hasText: "No se puede importar" }),
  ).toContainText("versión 99");
  await expect(
    dangerZone.getByRole("button", { name: "Importar y reemplazar" }),
  ).not.toBeVisible();

  // Nothing was imported: the pre-existing workspace is intact.
  await page.goto("/patrimonio");
  await expect(page.getByRole("cell", { name: "Activo preexistente 21" })).toBeVisible();
});
