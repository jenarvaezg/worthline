/**
 * Journey 27: Early repayments on an amortizable debt (PRD #146, slice S4 / #150),
 * on the debt's tabbed ficha since #1848.
 *
 * Once an amortizable debt has a plan, «Registrar amortización anticipada» is its
 * habitual action: the bar's primary, a form in the side panel. A past lump-sum
 * (reduce-payment | reduce-term) lands on the «Anticipadas» tab with the new row
 * marked; it is edited and deleted from that tab. A past repayment is a dated fact
 * that ripples the historical snapshots (visible in /historico). A future date is
 * rejected client-side (native max) and on the server.
 */

import { addHolding, expect, openFichaAction, openFichaTab, test } from "./fixtures";

/** A YYYY-MM-DD a given number of whole years before today. */
function yearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** A YYYY-MM-DD a given number of whole years after today (always future). */
function yearsAhead(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);

test("early repayment: add reduce-payment, edit to reduce-term, future rejected, past ripples to historico, delete", async ({
  page,
}) => {
  const editUrl = (id: string) => `/patrimonio/${id}/editar`;

  // 1. Create a liability.
  await addHolding(page, {
    instrument: "mortgage",
    name: "Hipoteca Anticipada",
    balance: "180000",
  });
  await expect(page.getByRole("status")).toHaveText("Deuda añadida.");

  const liabilityId = new URL(page.url()).hash.slice(1);
  expect(liabilityId).toBeTruthy();

  // 2–3. The alta of a mortgage already sets the amortizable model. Declare a PAST amortization plan (start ~6 years ago), on «Plan».
  const planStart = yearsAgo(6);
  await page.goto(editUrl(liabilityId));
  // With no plan yet, the origin-declared plan form starts demoted inside a
  // <details> (current-state entry is the primary path, S2 #677) — expand it.
  await page.getByText("¿Tienes los datos originales del préstamo?").click();
  const planForm = page.getByRole("form", { name: "Plan de amortización" });
  await planForm.getByLabel("Capital inicial en EUR").fill("200000");
  await planForm.getByLabel("Tipo de interés anual (%)").fill("2,5");
  await planForm.getByLabel("Plazo en meses").fill("360");
  await planForm.getByLabel("Fecha de firma").fill(planStart);
  await planForm.getByLabel("Fecha del primer pago").fill(planStart);
  await page.getByRole("button", { name: "Guardar plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Plan de amortización guardado.");

  // 4. Add a PAST early repayment (~3 years ago), reduce-payment — the bar's
  //    habitual action now that there is a plan.
  const repaymentDate = yearsAgo(3);
  await expect(
    page
      .getByRole("group", { name: "Acciones de la deuda" })
      .getByRole("button", { exact: true, name: "Registrar amortización anticipada" }),
  ).toHaveClass("btn");
  const addRepayment = await openFichaAction(page, "Registrar amortización anticipada");
  await addRepayment.getByLabel("Fecha de la amortización").fill(repaymentDate);
  await addRepayment.getByLabel("Importe en EUR").fill("10000");
  await addRepayment.getByLabel("Tipo de amortización").selectOption("reduce-payment");

  // 4b. A FUTURE repayment date is rejected client-side (native max=today).
  const futureDate = addRepayment.getByLabel("Fecha de la amortización");
  await futureDate.fill(yearsAhead(1));
  expect(await futureDate.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await expect(futureDate).toHaveAttribute("max", today);
  await futureDate.fill(repaymentDate); // restore the valid past date

  await addRepayment.getByRole("button", { name: "Registrar amortización" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Amortización anticipada registrada.",
  );
  // It lands on «Anticipadas», with the new row marked.
  await expect(page).toHaveURL(/pesta%C3%B1a=anticipadas|pestaña=anticipadas/);

  const repaymentTable = page.getByRole("table", {
    name: "Amortizaciones anticipadas",
  });
  await expect(repaymentTable.getByText(repaymentDate)).toBeVisible();
  await expect(repaymentTable.getByText(/10\.000/)).toBeVisible();
  await expect(repaymentTable.locator("tr[data-fresh]")).toContainText("nueva");
  // Scope to the cell: the collapsed inline-edit <select> keeps both mode
  // <option>s in the DOM, so getByText would strict-mode-violate.
  await expect(repaymentTable.getByRole("cell", { name: "Reducir cuota" })).toBeVisible();

  // 5. Edit the repayment: change the amount and switch the mode to reduce-term.
  await page.goto(editUrl(liabilityId));
  await openFichaTab(page, "Anticipadas");
  const repaymentRow = page.getByRole("row", { name: new RegExp(repaymentDate) });
  await repaymentRow.locator("summary", { hasText: "Editar" }).click();
  const editRepayment = page.getByRole("form", {
    name: "Editar amortización anticipada",
  });
  await editRepayment.getByLabel("Importe en EUR").fill("12000");
  await editRepayment.getByLabel("Tipo de amortización").selectOption("reduce-term");
  await editRepayment.getByRole("button", { name: "Guardar amortización" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Amortización anticipada actualizada.",
  );
  await expect(repaymentTable.getByText(/12\.000/)).toBeVisible();
  await expect(repaymentTable.getByRole("cell", { name: "Reducir plazo" })).toBeVisible();

  // 6. The past plan + repayment produced historical snapshots — in /historico.
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();
  await expect(page.locator(".dateKey").first()).toBeVisible();
  const snapshotDates = await page.locator(".dateKey").count();
  expect(snapshotDates).toBeGreaterThan(1);

  // 7. Delete the repayment (two-step confirm), from its tab.
  await page.goto(editUrl(liabilityId));
  await openFichaTab(page, "Anticipadas");
  const deleteRow = page.getByRole("row", { name: new RegExp(repaymentDate) });
  await deleteRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Amortización anticipada eliminada.");
  await expect(
    page
      .getByRole("table", { name: "Amortizaciones anticipadas" })
      .getByText(repaymentDate),
  ).toHaveCount(0);
});
