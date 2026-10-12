/**
 * Journey 16: Delete an investment operation (issue #81).
 *
 * Creates an investment with a manual price (no network), records a buy
 * operation, then deletes that operation and verifies the recent-operations
 * panel no longer shows it.
 *
 * #153 collapsed the /inversiones management section: add happens on the kept
 * /patrimonio/anadir route, and operations (record + delete) are managed on the
 * holding's own ficha (/patrimonio/[id]/editar) — since #1826 the record form in
 * its side panel and the ledger in its «Operaciones» tab.
 */

import {
  addHolding,
  delayServerActions,
  expect,
  holdingRow,
  openFichaAction,
  test,
  wholeDocument,
} from "./fixtures";

test("record an operation, then delete it", async ({ page }) => {
  // 1. New investment with a manual price (no ticker → no network).
  await addHolding(page, {
    instrument: "fund",
    name: "Inv Op Borrado",
    price: "50",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. Open the investment's ficha from the unified Patrimonio list.
  await page.goto("/patrimonio");
  await holdingRow(page, "Inv Op Borrado")
    .getByRole("link", { name: "Inv Op Borrado" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);

  // 3. Record a buy from the ficha's side panel.
  const panel = await openFichaAction(page, "Registrar operación");
  const opForm = panel.getByRole("form", { name: "Registrar operación" });
  await opForm.getByLabel("Unidades").fill("10");
  await opForm.getByLabel("Precio por unidad en EUR").fill("50");
  await opForm.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toBeVisible();
  // The terminal lands on the bare ficha, which names no action: the panel is gone.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 4. The «Operaciones» tab, on show by default, lists exactly one row.
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
  const opsPanel = page.locator(".recentOpsPanel");
  await expect(opsPanel).toBeVisible();
  await expect(opsPanel.locator("tbody tr")).toHaveCount(1);

  // 5. Delete that operation (two-step confirm). The delete is OPTIMISTIC (#521,
  //    interaction-patterns §4): with the Server Action held, the only row vanishes
  //    the instant we confirm — so the panel unrenders BEFORE the action resolves,
  //    without a document reload (a window sentinel a full reload wipes).
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const release = await delayServerActions(page, 2000);

  const opDelete = opsPanel.locator("tbody tr").first().locator("details.confirmDelete");
  await opDelete.locator("summary").click();
  await opDelete.getByRole("button", { name: "Confirmar" }).click();

  // «Not rendered» is a claim about the DOCUMENT, not about the screen: a
  // screen-scoped count would pass for a table that came back somewhere hidden
  // (#1351).
  await expect(wholeDocument(page).locator(".recentOpsPanel")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  await release();

  // 6. Success banner and the operation stays gone (panel not rendered).
  await expect(page.getByRole("status")).toContainText("Operación eliminada");
  await expect(wholeDocument(page).locator(".recentOpsPanel")).toHaveCount(0);
  await expect(page.getByText("Todavía no hay operaciones.")).toBeVisible();
});
