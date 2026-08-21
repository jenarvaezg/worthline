/**
 * Journey 51: a traspaso, end to end — ONE screen and ONE submit (#1480, PRD #1393).
 *
 * The acceptance criterion of the umbrella issue, measured rather than asserted in
 * prose. It records TWO traspasos, in this order and for this reason:
 *
 * 1. **To a destination that already exists, stated in participaciones** — the default
 *    reading (#1544) and the ordinary path, and the one that fails silently if any
 *    hidden pane — «crear destino», or the OTHER reading's VL fields — ever grows a
 *    native `required`: in a real browser that aborts the submit of the WHOLE form, so
 *    the action is never called and the URL never changes. A FormData-level test cannot
 *    see this (#677); only a browser can.
 * 2. **To a destination created on the way in, stated as importe + VL** — the creation
 *    pane, the reason it is in this form at all (a plan just opened at the bank), and
 *    the other reading, which has to keep working after the toggle is switched: the
 *    panes are disclosed by CSS `:has()`, so a browser is the only place that proves
 *    the fields the user can actually reach are the ones the parser reads.
 *
 * Both are then checked for the two properties that make a traspaso a traspaso rather
 * than a sale plus a purchase:
 *
 * - **The curve has no step.** Net worth is the same figure after each traspaso — the
 *   capital moved between holdings, it did not leave. Both are dated today, so the
 *   figure on screen IS the point of the curve they touch.
 * - **The origin's realized P/L does not move.** A traspaso is tax-neutral; a row
 *   labelled "Venta" with a P/L jump is exactly what this flow exists to stop.
 *
 * The arithmetic is chosen so every figure is exact: 10 participaciones at 100 €
 * (1.000 €); 200 € out at a VL of 100 € into a fund quoted at 50 € (2 out, 4 in);
 * then 400 € the same way (4 out, 8 in). 400 € + 200 € + 400 € = 1.000 €.
 */

import { addHolding, expect, holdingRow, openAdvancedSettings, test } from "./fixtures";

const ORIGIN = "Origen Traspaso E2E";
const EXISTING = "Destino Existente E2E";
const CREATED = "Destino Nuevo E2E";

/** Open a holding's ficha from the unified Patrimonio list, advanced block open. */
async function openFicha(page: import("@playwright/test").Page, name: string) {
  await page.goto("/patrimonio");
  const row = holdingRow(page, name);
  await expect(row).toBeVisible();
  await row.getByRole("link", { name }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);
}

/** The Patrimonio ledger's net-worth figure, as printed. */
async function netWorth(page: import("@playwright/test").Page): Promise<string> {
  await page.goto("/patrimonio");
  const net = page.locator(".balanceReconNet .balanceReconValue").first();
  await expect(net).toBeVisible();
  return (await net.textContent()) ?? "";
}

/** The «Traspasar» form on the origin's ficha, once the advanced block is open. */
function transferForm(page: import("@playwright/test").Page) {
  return page.getByRole("form", { name: "Traspasar a otra inversión" });
}

/**
 * The destination picker, located by its field name rather than by its label:
 * «inversión de destino» is a substring of three other accessible names in this form
 * (the search box, the created holding's name and its ISIN), so a label lookup is
 * ambiguous and fails Playwright's strict mode.
 */
function destinationPicker(page: import("@playwright/test").Page) {
  return transferForm(page).locator('select[name="destinationAssetId"]');
}

test("traspaso: one screen, one submit — to an existing fund and to a new one", async ({
  page,
}) => {
  // 1. The origin fund with a manual price (no ticker, so no network), the buy that
  //    gives it participaciones, and an empty fund to receive the first traspaso.
  await addHolding(page, { instrument: "fund", name: ORIGIN, price: "100" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");
  await addHolding(page, { instrument: "fund", name: EXISTING, price: "50" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await openFicha(page, ORIGIN);
  const operationForm = page.getByRole("form", { name: "Registrar operación" });
  await operationForm.getByLabel("Unidades").fill("10");
  await operationForm.getByLabel("Precio por unidad en EUR").fill("100");
  await operationForm.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);

  const netAfterBuy = await netWorth(page);

  // 2. Traspaso to the EXISTING fund — the main path, with the creation pane present
  //    in the DOM but hidden. If anything in that pane ever blocks native validation,
  //    this submit never reaches the server and the URL assertion below fails.
  await openFicha(page, ORIGIN);
  let form = transferForm(page);
  await expect(form).toBeVisible();

  // The origin's cached price arrives prefilled in the VL pane, even while that pane is
  // the hidden one — the VL of the day is the figure the user is least likely to have to
  // hand, and switching reading must not find an empty field.
  await expect(form.getByLabel("Valor liquidativo de origen")).toHaveValue("100");

  // The reading the screen opens in: the figures a justificante prints (#1544). The VL
  // fields are not reachable here, and no VL is typed anywhere in this traspaso.
  await expect(form.getByLabel("Participaciones que salieron del origen")).toBeVisible();
  await expect(form.getByLabel("Valor liquidativo de destino")).toBeHidden();

  await destinationPicker(page).selectOption({ label: EXISTING });
  await form.getByLabel("Importe traspasado en EUR").fill("200");
  await form.getByLabel("Participaciones que salieron del origen").fill("2");
  await form.getByLabel("Participaciones que entraron en el destino").fill("4");

  // The preview prints the pair BEFORE it is written, from the same code the gate
  // writes with: the participaciones as stated, and the VL each apunte will carry
  // derived from them (200 ÷ 2 = 100 out, 200 ÷ 4 = 50 in).
  await expect(form).toContainText("saldrán 2 participaciones");
  await expect(form).toContainText("entrarán 4");
  await expect(form).toContainText("100 EUR (origen)");

  await form.getByRole("button", { name: "Registrar traspaso" }).click();
  await expect(page).toHaveURL(/ok=transfer_recorded/);
  await expect(page.getByRole("status")).toHaveText("Traspaso registrado.");

  // The origin's ledger says what happened, in its own words — not "Venta".
  await openAdvancedSettings(page);
  await expect(page.locator(".recentOpsPanel")).toContainText("Traspaso (salida)");
  // 8 of the 10 participaciones are left, worth 800 € — the context panel prints a
  // round figure without decimals, so this asserts the figure and not its padding.
  await expect(page.locator(".operacionContext")).toContainText("Unidades actuales8");
  await expect(page.locator(".operacionContext")).toContainText("800 €");
  expect(await netWorth(page)).toBe(netAfterBuy);

  // 3. Traspaso to a destination CREATED on the way in, stated the other way — one
  //    screen, one submit, and the VL pane reached through the toggle.
  await openFicha(page, ORIGIN);
  form = transferForm(page);
  await destinationPicker(page).selectOption("__new__");
  // The pane is disclosed by CSS `:has()`, so it is reachable with or without JS.
  const newName = form.getByLabel("Nombre de la inversión de destino");
  await expect(newName).toBeVisible();
  await newName.fill(CREATED);
  await form.getByLabel("El importe y el valor liquidativo").check();
  const destinationPrice = form.getByLabel("Valor liquidativo de destino");
  await expect(destinationPrice).toBeVisible();
  await form.getByLabel("Importe traspasado en EUR").fill("400");
  await destinationPrice.fill("50");
  await form.getByRole("button", { name: "Registrar traspaso" }).click();

  await expect(page).toHaveURL(/ok=transfer_recorded/);
  await expect(page.getByRole("status")).toHaveText("Traspaso registrado.");

  // 4. Nothing was realized: a traspaso is not a sale (ADR 0082).
  await openAdvancedSettings(page);
  await expect(page.locator(".returnsPanel")).toContainText("P/L realizado");
  expect(
    await page
      .locator(".returnsPanel")
      // A round figure prints without decimals in this panel, so both spellings of
      // «nothing was realized» count — what matters is the zero.
      .getByText(/^[+-]?0(,00)?\s€$/)
      .count(),
  ).toBeGreaterThan(0);

  // 5. Both destinations hold the capital that left, and net worth never moved: no
  //    step in the curve.
  expect(await netWorth(page)).toBe(netAfterBuy);
  // The list prints a round figure without decimals, and prefixes a computed value
  // with «≈» — so the assertion is on the figure, not on its punctuation.
  await expect(holdingRow(page, EXISTING)).toContainText("200 €");
  await expect(holdingRow(page, CREATED)).toContainText("400 €");
  await expect(holdingRow(page, ORIGIN)).toContainText("400 €");
});
