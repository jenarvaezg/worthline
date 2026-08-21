/**
 * Journey 51: a traspaso, end to end — ONE screen and ONE submit (#1480, PRD #1393).
 *
 * The acceptance criterion of the umbrella issue, measured rather than asserted in
 * prose: from the origin holding's ficha, with the destination fund created on the
 * way in, a traspaso lands with a single click. And the two properties that make it a
 * traspaso rather than a sale plus a purchase:
 *
 * - **The curve has no step.** Net worth before and after is the same figure to the
 *   cent — the capital moved between two holdings, it did not leave.
 * - **The origin's realized P/L does not move.** A traspaso is tax-neutral; a row
 *   labelled "Venta" with a P/L jump is exactly what this flow exists to stop.
 *
 * The arithmetic is chosen so both are exact: 10 participaciones at 100 € (1.000 €),
 * 400 € traspasado at a VL of 100 € (4 units out) into a destination quoted at 50 €
 * (8 units in) → 600 € + 400 €.
 */

import { addHolding, expect, holdingRow, openAdvancedSettings, test } from "./fixtures";

const ORIGIN = "Origen Traspaso E2E";
const DESTINATION = "Destino Traspaso E2E";

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

test("traspaso: one screen, one submit — no step in the curve, no realized P/L", async ({
  page,
}) => {
  // 1. An origin fund with a manual price (no ticker, so no network), plus the buy
  //    that gives it participaciones to traspasar.
  await addHolding(page, { instrument: "fund", name: ORIGIN, price: "100" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await openFicha(page, ORIGIN);
  const operationForm = page.getByRole("form", { name: "Registrar operación" });
  await operationForm.getByLabel("Unidades").fill("10");
  await operationForm.getByLabel("Precio por unidad en EUR").fill("100");
  await operationForm.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);

  const netBefore = await netWorth(page);

  // 2. The traspaso itself: destination created inline, one date, one importe, the
  //    two VLs — and a single submit.
  await openFicha(page, ORIGIN);
  const transferForm = page.getByRole("form", { name: "Traspasar a otra inversión" });
  await expect(transferForm).toBeVisible();

  // The origin's cached price arrives prefilled — the VL of the day is the figure
  // the user is least likely to have to hand.
  await expect(transferForm.getByLabel("Valor liquidativo de origen")).toHaveValue("100");

  await transferForm.getByLabel("Inversión de destino").selectOption("__new__");
  // The creation pane is disclosed by CSS `:has()`, so it is reachable with or
  // without JS — and it carries no `required`, which would have aborted the submit
  // of this whole form while it was hidden (#677).
  const newName = transferForm.getByLabel("Nombre de la inversión de destino");
  await expect(newName).toBeVisible();
  await newName.fill(DESTINATION);

  await transferForm.getByLabel("Importe traspasado en euros").fill("400");
  await transferForm.getByLabel("Valor liquidativo de destino").fill("50");

  // 3. The preview prints the pair BEFORE it is written, from the same code the gate
  //    writes with: 400 ÷ 100 out, 400 ÷ 50 in.
  await expect(transferForm).toContainText("saldrán 4 participaciones");
  await expect(transferForm).toContainText("entrarán 8");

  await transferForm.getByRole("button", { name: "Registrar traspaso" }).click();

  await expect(page).toHaveURL(/ok=transfer_recorded/);
  await expect(page.getByRole("status")).toHaveText("Traspaso registrado.");

  // 4. The origin's ledger says what happened, in its own words — not "Venta".
  await openAdvancedSettings(page);
  await expect(page.locator(".recentOpsPanel")).toContainText("Traspaso (salida)");
  const context = page.locator(".operacionContext");
  await expect(context).toContainText("6");
  await expect(context).toContainText("600,00 €");

  // 5. Nothing was realized: the traspaso is not a sale (ADR 0082).
  await expect(page.locator(".returnsPanel")).toContainText("P/L realizado");
  await expect(page.locator(".returnsPanel dd").first()).toBeVisible();
  expect(
    await page
      .locator(".returnsPanel")
      .getByText(/^[+-]?0,00\s€$/)
      .count(),
  ).toBeGreaterThan(0);

  // 6. The destination exists, holding the capital that left — and the net worth is
  //    the same figure it was before the traspaso: no step in the curve.
  expect(await netWorth(page)).toBe(netBefore);
  await expect(holdingRow(page, DESTINATION)).toContainText("400,00 €");
});
