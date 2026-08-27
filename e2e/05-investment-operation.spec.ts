/**
 * Journey 5: New investment → record buy operation → derived value renders.
 *            Typed input survives a validation error (units field left empty).
 *
 * Uses MANUAL price (no ticker) to avoid any network calls to stooq.
 *
 * #153 collapsed the /inversiones management section: an investment is ADDED via
 * the unified /patrimonio/anadir route, then appears in the unified Patrimonio list,
 * and its operations + derived value are managed on its own ficha
 * (/patrimonio/[id]/editar). This journey exercises that path end to end. The
 * unrealized-P/L column lived only on the removed /inversiones list; its sole
 * surface is gone, so this asserts the derived market value (units × price) that
 * the ficha now shows — re-surfacing P/L in the Patrimonio list is S8 (#154).
 */

import {
  addHolding,
  delayServerActions,
  expect,
  holdingRow,
  openAdvancedSettings,
  test,
} from "./fixtures";

test("investment: create with manual price → buy operation → derived value visible", async ({
  page,
}) => {
  // 1. Add the investment via the unified add route (/patrimonio/anadir).
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo Test E2E",
    price: "100",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 4. The investment is reachable from the unified Patrimonio list; open its ficha.
  await page.goto("/patrimonio");
  const investmentRow = holdingRow(page, "Fondo Test E2E");
  await expect(investmentRow).toBeVisible();
  await investmentRow.getByRole("link", { name: "Fondo Test E2E" }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);

  // 5. The ficha shows the DERIVED operations surface (units × price), not a
  //    manual value field (ADR 0006: an investment's value is never edited).
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
  await expect(page.getByLabel("Valor actual en EUR")).toHaveCount(0);

  const operationForm = page.getByRole("form", { name: "Registrar operación" });

  // 6. Trigger a validation error: submit with units left empty. The server
  //    rejects the empty units field and the refusal comes BACK to the form as
  //    state — it does not navigate (#1311).
  await operationForm.getByLabel("Precio por unidad en EUR").fill("105,50");
  await operationForm.getByLabel("Unidades").clear();
  await operationForm.getByRole("button", { name: "Registrar operación" }).click();

  // 7. The refusal lands IN PLACE. Since #1311 the record terminal is split —
  //    success redirects, a rejection is returned — so there is no navigation to
  //    wait out here, and none of this journey's historical flakiness (a fill
  //    landing on the pre-navigation form node, discarded by the RSC swap) has a
  //    mechanism left. The band is the deterministic signal.
  const errorBand = page.locator("#operation-error");
  await expect(errorBand).toBeVisible();
  await expect(errorBand).toHaveText("Las unidades son obligatorias.");
  // What the absence of a navigation buys, asserted rather than assumed: the URL
  // is untouched (the typed amounts never ride the address bar), the advanced
  // block the user opened is still open (nothing remounted it shut), and the
  // typed price is still in the field it was typed into.
  await expect(page).not.toHaveURL(/error=/);
  await expect(page.locator("details.editAdvanced")).toHaveJSProperty("open", true);
  await expect(operationForm.getByLabel("Precio por unidad en EUR")).toHaveValue(
    "105,50",
  );

  // 8. Re-fill both fields on the settled form and confirm the DOM values stuck
  //    before submitting (assert the values rather than polling FormData — a
  //    deterministic, non-racy check against the live inputs).
  await operationForm.getByLabel("Unidades").fill("10");
  await operationForm.getByLabel("Precio por unidad en EUR").fill("105,50");
  await expect(operationForm.getByLabel("Unidades")).toHaveValue("10");
  await expect(operationForm.getByLabel("Precio por unidad en EUR")).toHaveValue(
    "105,50",
  );

  // 8b. Recording is OPTIMISTIC (#521, interaction-patterns §4): with the Server
  //     Action held, the operation row must appear in the list BEFORE the action
  //     resolves — without a document reload (a window sentinel a full reload wipes).
  //     Only the row is faked; the derived context (units/value) settles on redirect.
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const release = await delayServerActions(page, 2000);

  await operationForm.getByRole("button", { name: "Registrar operación" }).click();

  await expect(page.locator(".recentOpsPanel")).toContainText("105,50");
  await expect(page).not.toHaveURL(/ok=saved/);
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  await release();

  // 9. Success redirect — the action lands back on the ficha with `ok=saved`.
  //    Wait for that URL transition first (the deterministic signal the operation
  //    persisted), then assert the status banner.
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toHaveText("Guardado.");
  await openAdvancedSettings(page);

  // 10. The ficha's derived context now reports 10 units and the derived market
  //     value (10 × 100 EUR manual price = 1.000 €). The manual price is 100 even
  //     though the buy was at 105,50 — value is units × current price (ADR 0006),
  //     not cost basis; this is the same figure the Patrimonio list shows.
  const ctx = page.locator(".operacionContext");
  await expect(ctx.getByText("10", { exact: true })).toBeVisible();
  await expect(ctx.getByText(/1\.?000\s*€/)).toBeVisible();

  // 11. The unified Patrimonio list shows the same derived value for the holding.
  //     Assert against the row's full text (not a positional cell) so the check
  //     is robust to the optional household ownership label.
  await page.goto("/patrimonio");
  const listRow = holdingRow(page, "Fondo Test E2E");
  await expect(listRow).toBeVisible();
  const rowText = await listRow.textContent();
  expect(rowText).toBeTruthy();
  expect(rowText).toMatch(/1\.?000\s*€/);
});
