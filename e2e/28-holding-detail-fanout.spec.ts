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
 *
 * Since #1826 the derived ficha is the tabbed one: the state header says the units
 * and the value, the record form opens in the side panel, the ledger is a tab.
 */

import {
  addHolding,
  expect,
  holdingRow,
  openFichaAction,
  openFichaTab,
  test,
} from "./fixtures";

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
  const row = holdingRow(page, "Fondo Ficha S6");
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Fondo Ficha S6" }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  const assetId = new URL(page.url()).pathname.split("/")[2]!;
  expect(assetId).toBeTruthy();

  // 3. The detail page shows the DERIVED operations surface (units × price), not
  //    a manual value field (ADR 0006: an investment's value is never edited).
  const operationsRegion = page.getByRole("region", {
    name: "Operaciones de la inversión",
  });
  await expect(operationsRegion).toBeVisible();
  await expect(page.getByLabel("Valor actual en EUR")).toHaveCount(0);
  const state = page.getByRole("region", { name: "Estado del activo" });

  // 4. Record a BUY of 10 units @ 100 from the side panel.
  let panel = await openFichaAction(page, "Registrar operación");
  let opForm = panel.getByRole("form", { name: "Registrar operación" });
  await opForm.getByLabel("Unidades").fill("10");
  await opForm.getByLabel("Precio por unidad en EUR").fill("100");
  await opForm.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toHaveText("Guardado.");

  // 5. The state header now reports the units held and the derived value.
  await expect(state.locator(".fichaFigures")).toContainText("10 a 100 €");
  await expect(state.locator(".fichaValue")).toHaveText(/1\.?000\s*€/); // 10 × 100

  // 6. Record a SELL of 4 units @ 120 from the same panel.
  panel = await openFichaAction(page, "Registrar operación");
  opForm = panel.getByRole("form", { name: "Registrar operación" });
  await opForm.getByLabel("Tipo").selectOption("sell");
  await opForm.getByLabel("Unidades").fill("4");
  await opForm.getByLabel("Precio por unidad en EUR").fill("120");
  await opForm.getByRole("button", { name: "Registrar operación" }).click();
  // Waiting on the URL is no signal here: this redirect lands on the SAME
  // `?ok=saved` URL step 4 already produced. The honest signal is the settled
  // figure the server re-rendered, on the header that is always on screen.
  await expect(state.locator(".fichaFigures")).toContainText("6 a 100 €");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 7. Both operations are listed in the «Operaciones» tab.
  const opsPanel = operationsRegion.locator(".recentOpsPanel");
  await expect(opsPanel).toBeVisible();
  await expect(opsPanel.locator("tbody tr")).toHaveCount(2);

  // 8. Delete the sell operation (its «⋯», then the two-step confirm, #1827).
  const sellRow = opsPanel.locator("tbody tr").filter({ hasText: "Venta" });
  await sellRow.getByLabel(/^Acciones de la operación del /).click();
  await sellRow.locator("details.confirmDelete summary").click();
  await sellRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toContainText("Operación eliminada");

  // 9. Only the buy remains; units back to 10.
  await expect(operationsRegion.locator(".recentOpsPanel tbody tr")).toHaveCount(1);
  await expect(state.locator(".fichaFigures")).toContainText("10 a 100 €");
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

  const ficha = `/patrimonio/${id}/editar`;
  await page.goto(ficha);
  // Stored ficha (#1846): a state header with the value and when it was put up to
  // date — no operations, no curve.
  const state = page.getByRole("region", { name: "Estado del activo" });
  await expect(state.locator(".fichaValue")).toHaveText(/5\.?000\s*€/);
  await expect(state.locator(".fichaFigures")).toContainText("Puesto al día");
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toHaveCount(0);

  // «Actualizar valor» is the bar's habitual action, in the side panel.
  let panel = await openFichaAction(page, "Actualizar valor");
  await expect(page).toHaveURL(/accion=valor/);

  // A value that is not one comes back to the same panel, with what was typed and
  // why, said once (#1846).
  await panel.getByLabel("Valor actual en EUR").fill("cinco mil");
  await panel.getByRole("button", { name: "Actualizar valor" }).click();
  await expect(page).toHaveURL(/form=value/);
  panel = page.getByRole("dialog", { name: "Actualizar valor" });
  await expect(panel.getByRole("alert")).toHaveText("El valor del activo no es válido.");
  await expect(page.getByText("El valor del activo no es válido.")).toHaveCount(1);
  await expect(panel.getByLabel("Valor actual en EUR")).toHaveValue("cinco mil");

  await panel.getByLabel("Valor actual en EUR").fill("5500");
  await panel.getByRole("button", { name: "Actualizar valor" }).click();

  // The person stays on the ficha: the notice, the new value, today's date.
  await expect(page).toHaveURL(new RegExp(`${ficha}\\?ok=saved`));
  await expect(page.getByRole("status")).toHaveText("Guardado.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(state.locator(".fichaValue")).toHaveText(/5\.?500\s*€/);
  const [y, m, d] = today.split("-");
  await expect(state.locator(".fichaFigures")).toContainText(`${d}/${m}/${y}`);
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
  // Housing ficha (#1847): a state header with the curve's value, its last
  // appraisal and its rate.
  const state = page.getByRole("region", { name: "Estado del activo" });
  await expect(state.locator(".fichaValue")).toHaveText(/220\.?000\s*€/);
  await expect(state.locator(".fichaFigures")).toContainText("Última tasación");
  await expect(state.locator(".fichaFigures")).toContainText("Adquisición · 10/01/2021");

  // With no cobros it opens on «Valoración», the curve with its rate field.
  await expect(
    page.getByRole("region", { name: "Valoración del inmueble" }),
  ).toBeVisible();
  await page.getByLabel("Tasa de revalorización anual (%)").fill("3");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("3");
  await expect(state.locator(".fichaFigures")).toContainText("3,00 %");

  // Cobros is a tab away, and «Registrar tasación» opens in the panel over it.
  await openFichaTab(page, "Cobros");
  await expect(page.locator("#cobros")).toBeVisible();
  const panel = await openFichaAction(page, "Registrar tasación");
  await expect(panel.getByLabel("Fecha de la tasación")).toHaveValue(today);
  await panel.getByRole("button", { name: "Cerrar" }).click();
  await openFichaTab(page, "Valoración");
  await expect(page.getByRole("table", { name: "Tasaciones" })).toBeVisible();
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
  // The debt ficha (#1848): the alta of a mortgage sets it amortizable, and with no
  // plan yet the stored balance is still the figure — «Actualizar saldo» leads.
  const state = page.getByRole("region", { name: "Estado de la deuda" });
  await expect(state).toContainText("Amortizable (préstamo francés)");
  const balancePanel = await openFichaAction(page, "Actualizar saldo");
  await balancePanel.getByLabel("Saldo pendiente en EUR").fill("29.500,00");
  await balancePanel.getByRole("button", { name: "Actualizar saldo" }).click();
  // It comes back to the ficha, not the board, with the new figure in the header.
  await expect(page).toHaveURL(new RegExp(`/patrimonio/${id}/editar\\?ok=saved`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(state.locator(".fichaValue")).toHaveText(/−\s29\.?500\s*€/);

  // No model: the header says so, and «Elegir modelo» becomes the habitual action.
  const clearPanel = await openFichaAction(page, "Modelo de deuda");
  await clearPanel.getByRole("combobox", { name: "Modelo de deuda" }).selectOption("");
  await clearPanel.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page).toHaveURL(/ok=debt_model_saved/);
  await expect(state).toContainText("Sin modelo");

  // amortized: choose amortizable → the «Plan» tab appears, open by default.
  const modelPanel = await openFichaAction(page, "Elegir modelo");
  await modelPanel
    .getByRole("combobox", { name: "Modelo de deuda" })
    .selectOption("amortizable");
  await modelPanel.getByRole("button", { name: "Guardar modelo" }).click();
  // Saving the model redirects (?ok=debt_model_saved) and re-renders the ficha via
  // RSC. Wait for that navigation to LAND before touching the revealed plan form —
  // otherwise the in-flight re-render tears down and rebuilds the whole subtree,
  // detaching inputs and the submit button mid-action (flaked ~1/3).
  await expect(page).toHaveURL(/ok=debt_model_saved/);
  // With no plan yet, the origin-declared plan form starts demoted inside a
  // <details> (current-state entry is the primary path, S2 #677) — expand it.
  const originalPlanDetails = page.locator(".fichaTabBody details", {
    hasText: "¿Tienes los datos originales del préstamo?",
  });
  await originalPlanDetails.locator("summary").click();
  await expect(originalPlanDetails).toHaveJSProperty("open", true);
  // Scope to the plan form: the current-state block also renders a
  // "Fecha de firma original" field, so page-level getByLabel is ambiguous.
  const planForm = originalPlanDetails.getByRole("form", {
    name: "Plan de amortización",
  });
  await expect(planForm).toBeVisible();
  await planForm.getByLabel("Capital inicial en EUR").fill("30000");
  await planForm.getByLabel("Tipo de interés anual (%)").fill("2,5");
  await planForm.getByLabel("Plazo en meses").fill("120");
  await planForm.getByLabel("Fecha de firma").fill("2023-01-01");
  await planForm.getByLabel("Fecha del primer pago").fill("2023-03-01");
  await planForm.getByRole("button", { name: "Guardar plan" }).click();
  await expect(page).toHaveURL(/ok=plan_saved/);
  await expect(page.getByRole("status")).toBeVisible();
  // With a plan the balance door is gone: the curve governs the figure (#1290).
  await expect(state).toContainText("Cuota vigente");
  await expect(
    page
      .getByRole("group", { name: "Acciones de la deuda" })
      .getByRole("button", { exact: true, name: "Actualizar saldo" }),
  ).toHaveCount(0);

  // anchored: switch to revolving, from «Más» → «Saldos», with «Registrar saldo».
  const switchPanel = await openFichaAction(page, "Modelo de deuda");
  await switchPanel
    .getByRole("combobox", { name: "Modelo de deuda" })
    .selectOption("revolving");
  await switchPanel.getByRole("button", { name: "Guardar modelo" }).click();
  // Same settle-before-interact: wait for the model-save redirect to land so the
  // balance-anchor panel is the stable, post-navigation node.
  await expect(page).toHaveURL(/ok=debt_model_saved/);
  const anchorPanel = await openFichaAction(page, "Registrar saldo");
  await anchorPanel.getByLabel("Fecha del saldo").fill(today);
  await anchorPanel.getByLabel("Saldo restante en EUR").fill("12500");
  await anchorPanel.getByRole("button", { name: "Registrar saldo" }).click();
  await expect(page).toHaveURL(/ok=balance_anchor_added/);
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("table", { name: "Saldos declarados" })).toBeVisible();
  await expect(state.locator(".fichaValue")).toHaveText(/−\s12\.?500\s*€/);
});

test("a refused balance reopens its panel on the debt ficha and says why once (#1848)", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "mortgage",
    name: "Préstamo rechazo",
    balance: "30000",
  });
  await expect(page.getByRole("status")).toHaveText("Deuda añadida.");
  const id = new URL(page.url()).hash.slice(1);

  await page.goto(`/patrimonio/${id}/editar`);
  const panel = await openFichaAction(page, "Actualizar saldo");
  await panel.getByLabel("Saldo pendiente en EUR").fill("mucho");
  await panel.getByRole("button", { name: "Actualizar saldo" }).click();

  const reopened = page.getByRole("dialog", { name: "Actualizar saldo" });
  await expect(reopened.getByRole("alert")).toHaveText(
    "El saldo de la deuda no es válido.",
  );
  await expect(page.getByText("El saldo de la deuda no es válido.")).toHaveCount(1);
  await expect(reopened.getByLabel("Saldo pendiente en EUR")).toHaveValue("mucho");
});
