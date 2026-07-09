/**
 * Journey 22: Import from onboarding — second entry point for fresh installs
 * (#105).
 *
 * Runs after 21, which leaves a populated workspace. The journey first reaches
 * a genuinely fresh install by running the real "borrar todo" reset from the
 * /ajustes danger zone (landing on /empezar), then sets the app up straight
 * from a file: a LIVE-STATE-ONLY export document — only version, workspace,
 * members and assets; no snapshots/trash/priceCache keys at all — uploaded in
 * the /empezar import section. The preview must show the content summary but
 * OMIT the data-loss warning (there is no workspace yet, nothing to lose), and
 * confirming must land on the populated dashboard "/", never back in
 * onboarding. Absent sections import as empty — the papelera ends up vacía.
 */

import { expect, holdingRow, test } from "./fixtures";

/**
 * A live-state-only version-2 export document, as an externally-prepared file
 * would carry it: no snapshots, no trash, no priceCache, no operations — only
 * the live workspace, its member, and two holdings.
 */
const liveStateOnlyDoc = {
  version: 2,
  workspace: { mode: "individual", baseCurrency: "EUR" },
  members: [{ id: "member-onboarding-22", name: "Onboarding Veintidós" }],
  assets: [
    {
      id: "asset-cuenta-onboarding-22",
      name: "Cuenta onboarding 22",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 555500, currency: "EUR" },
      liquidityTier: "cash",
      isPrimaryResidence: false,
      ownership: [{ memberId: "member-onboarding-22", shareBps: 10000 }],
    },
    {
      id: "asset-coche-onboarding-22",
      name: "Coche onboarding 22",
      type: "manual",
      currency: "EUR",
      currentValue: { amountMinor: 800000, currency: "EUR" },
      liquidityTier: "illiquid",
      isPrimaryResidence: false,
      ownership: [{ memberId: "member-onboarding-22", shareBps: 10000 }],
    },
  ],
};

test("fresh install imports a live-state-only file from /empezar and lands on the dashboard", async ({
  page,
}) => {
  // ── Reach a fresh install: real "borrar todo" reset from /ajustes ────────
  await page.goto("/ajustes");

  const dangerZone = page.locator("section.dangerZone");
  await expect(
    dangerZone.getByRole("heading", { name: "Zona de peligro" }),
  ).toBeVisible();

  await dangerZone.locator("details.confirmDelete > summary").click();
  await page.getByLabel("Frase de confirmación de borrado total").fill("borrar todo");
  await page.getByRole("button", { name: "Borrar todo definitivamente" }).click();

  await expect(page).toHaveURL(/\/empezar/);

  // ── The import path is offered alongside solo/hogar ──────────────────────
  await expect(page.getByRole("heading", { name: "Empezar solo" })).toBeVisible();
  const importSection = page.getByRole("region", { name: "Importar una copia" });
  await expect(
    importSection.getByRole("heading", { name: "¿Ya tienes una copia de worthline?" }),
  ).toBeVisible();

  // No confirm button exists before any preview.
  await expect(
    importSection.getByRole("button", { name: "Importar y reemplazar" }),
  ).not.toBeVisible();

  // ── Preview: content summary shown, data-loss warning OMITTED ────────────
  await importSection.locator('input[name="file"]').setInputFiles({
    name: "worthline-live-state.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(liveStateOnlyDoc)),
  });
  await importSection.getByRole("button", { name: "Ver contenido del archivo" }).click();

  // Content summary, per section — absent sections counted as empty.
  await expect(importSection.getByText("1 miembro", { exact: true })).toBeVisible();
  await expect(importSection.getByText("2 activos", { exact: true })).toBeVisible();
  await expect(importSection.getByText("0 pasivos", { exact: true })).toBeVisible();
  await expect(importSection.getByText("0 operaciones", { exact: true })).toBeVisible();
  await expect(importSection.getByText("0 snapshots", { exact: true })).toBeVisible();
  await expect(
    importSection.getByText("Papelera: 0 activos y 0 pasivos", { exact: true }),
  ).toBeVisible();

  // There is no workspace to lose — the warning journey 21 asserts FOR
  // presence in /ajustes must NOT appear here.
  await expect(
    page.getByText("se reemplazará por completo y se perderá", { exact: false }),
  ).not.toBeVisible();

  // ── Confirm: lands on the populated dashboard, not back in onboarding ────
  await importSection.getByRole("button", { name: "Importar y reemplazar" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");

  // The dashboard shows the imported holdings: expand the Caja tier in the
  // liquidity pyramid and find the imported cash account.
  const liquidityPanel = page.getByRole("region", { name: "Liquidez por capa" });
  await liquidityPanel.locator("details.tier.cash > summary").click();
  await expect(liquidityPanel.getByText("+ Cuenta onboarding 22")).toBeVisible();

  // Both imported assets are in the holdings listing.
  await page.goto("/patrimonio");
  await expect(holdingRow(page, "Cuenta onboarding 22")).toBeVisible();
  await expect(holdingRow(page, "Coche onboarding 22")).toBeVisible();

  // Absent sections were left empty: the papelera is vacía.
  const papelera = page.locator("details.balanceTrash");
  await expect(papelera.locator("> summary")).toHaveText(/Papelera \(0\)/);
  await papelera.locator("> summary").click();
  await expect(papelera.getByText("La papelera está vacía.")).toBeVisible();
});
