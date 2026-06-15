/**
 * Journey 28: The per-holding detail page fans out by valuation method (PRD #146,
 * slice S6, #152).
 *
 * The single detail/ficha page `/patrimonio/[id]/editar` renders the correct
 * configuration surface for each valuation method. The NEW capability is the
 * `derived` surface: an investment's operations editor (record buy → see units /
 * value → record sell → delete operation) reachable from the detail page — no
 * longer only under /inversiones. The four pre-existing surfaces (stored,
 * appreciating, amortized, anchored) must still render/edit from the detail page.
 */

import { test, expect, addHolding } from "./fixtures";

const today = new Date().toISOString().slice(0, 10);

test("derived: manage an investment's operations from /patrimonio/[id]/editar", async ({
  page,
}) => {
  // 1. Create an investment with a MANUAL price (no ticker → no network).
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo Ficha S6",
    price: "100",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. The investment is reachable from the unified Patrimonio list and its
  //    detail page is /patrimonio/[id]/editar.
  await page.goto("/patrimonio");
  const row = page.getByRole("row", { name: /Fondo Ficha S6/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Fondo Ficha S6" }).click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  const assetId = new URL(page.url()).pathname.split("/")[2]!;
  expect(assetId).toBeTruthy();

  // 3. The detail page shows the DERIVED operations surface (units × price), not
  //    a manual value field (ADR 0006: an investment's value is never edited).
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
  await expect(page.getByLabel("Valor actual en EUR")).toHaveCount(0);

  // 4. Record a BUY of 10 units @ 100 from the detail page.
  const opForm = page.getByRole("form", { name: "Registrar operación" });
  await opForm.getByLabel("Unidades").fill("10");
  await opForm.getByLabel("Precio por unidad en EUR").fill("100");
  await page.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toHaveText("Guardado.");

  // 5. The detail surface now reports the units held and the derived value.
  const ctx = page.locator(".operacionContext");
  await expect(ctx.getByText("10", { exact: true })).toBeVisible();
  await expect(ctx.getByText(/1\.?000\s*€/)).toBeVisible(); // 10 × 100 = 1000 €

  // 6. Record a SELL of 4 units @ 120 from the same page.
  await opForm.getByLabel("Tipo").selectOption("sell");
  await opForm.getByLabel("Unidades").fill("4");
  await opForm.getByLabel("Precio por unidad en EUR").fill("120");
  await page.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);

  // 7. Both operations are listed; remaining units = 6.
  const opsPanel = page.locator("details.recentOpsPanel");
  await expect(opsPanel).toBeVisible();
  await expect(opsPanel.locator("tbody tr")).toHaveCount(2);
  await expect(ctx.getByText("6", { exact: true })).toBeVisible();

  // 8. Delete the sell operation (two-step confirm in its row).
  const sellRow = opsPanel.locator("tbody tr").filter({ hasText: "Venta" });
  await sellRow.locator("details.confirmDelete summary").click();
  await sellRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toContainText("Operación eliminada");

  // 9. Only the buy remains; units back to 10.
  await expect(page.locator("details.recentOpsPanel tbody tr")).toHaveCount(1);
  await expect(
    page.locator(".operacionContext").getByText("10", { exact: true }),
  ).toBeVisible();
});

test("stored: a cash asset edits its current value from the detail page", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "current_account",
    name: "Cuenta Corriente S6",
    value: "5000",
  });
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");
  const id = new URL(page.url()).hash.slice(1);

  await page.goto(`/patrimonio/${id}/editar`);
  // Stored surface: a current-value field is offered (no operations, no curve).
  const valueField = page.getByLabel("Valor actual en EUR");
  await expect(valueField).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toHaveCount(0);
  await valueField.fill("5500");
  await page.getByRole("button", { name: "Actualizar valor" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  // The action redirects to the list on success; re-open the detail to confirm.
  await page.goto(`/patrimonio/${id}/editar`);
  await expect(page.getByLabel("Valor actual en EUR")).toHaveValue(/5\.?500/);
});

test("appreciating: a property edits its valuation curve from the detail page", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "property",
    name: "Piso S6",
    acqDate: "2021-01-10",
    acqValue: "220000",
  });
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");
  const id = new URL(page.url()).hash.slice(1);

  await page.goto(`/patrimonio/${id}/editar`);
  // Appreciating surface: the housing valuation region with a rate field.
  await expect(
    page.getByRole("region", { name: "Valoración del inmueble" }),
  ).toBeVisible();
  await page.getByLabel("Tasa de revalorización anual (%)").fill("3");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("3");
});

test("amortized & anchored: a liability switches debt-model surfaces from the detail page", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "mortgage",
    name: "Préstamo S6",
    balance: "30000",
  });
  await expect(page.getByRole("status")).toHaveText("Deuda añadida.");
  const id = new URL(page.url()).hash.slice(1);

  await page.goto(`/patrimonio/${id}/editar`);
  // The debt-model region lets the user pick the method, which fans out a surface.
  const debtRegion = page.getByRole("region", { name: "Modelo de deuda" });
  await expect(debtRegion).toBeVisible();
  const modelSelect = debtRegion.getByRole("combobox", { name: "Modelo de deuda" });

  // amortized: pick amortizable → the plan editor appears.
  await modelSelect.selectOption("amortizable");
  await page.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page.getByRole("form", { name: "Plan de amortización" })).toBeVisible();
  await page.getByLabel("Capital inicial en EUR").fill("30000");
  await page.getByLabel("Tipo de interés anual (%)").fill("2,5");
  await page.getByLabel("Plazo en meses").fill("120");
  await page.getByLabel("Fecha de inicio").fill("2023-01-01");
  await page.getByRole("button", { name: "Guardar plan" }).click();
  await expect(page.getByRole("status")).toBeVisible();

  // anchored: switch to revolving → the balance-anchor editor appears.
  await debtRegion
    .getByRole("combobox", { name: "Modelo de deuda" })
    .selectOption("revolving");
  await page.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page.getByRole("form", { name: "Registrar saldo" })).toBeVisible();
  await page.getByLabel("Fecha del saldo").fill(today);
  await page.getByLabel("Saldo restante en EUR").fill("12500");
  await page.getByRole("button", { name: "Registrar saldo" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("table", { name: "Saldos declarados" })).toBeVisible();
});
