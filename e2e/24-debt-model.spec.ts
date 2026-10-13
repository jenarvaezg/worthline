/**
 * Journey 24: Debt-model editing (PRD #109, slice 10) — on the debt's tabbed
 * ficha since #1848.
 *
 * On a liability's /patrimonio/[id]/editar page the user can:
 *   - change the debt model from the «Modelo de deuda» panel,
 *   - for an amortizable debt (what the alta of a mortgage sets): declare an amortization plan on the «Plan» tab,
 *     recalibrate it with the bank's real figure, and manage its interest-rate
 *     revisions — registered from the bar's panel, landing on «Revisiones» with
 *     the new row marked, edited and deleted from that tab,
 *   - for a revolving/informal debt: declare balance anchors from the bar, listed
 *     date-desc on «Saldos», edited and deleted there,
 *   - and is blocked from declaring a future-dated event (native max + server).
 *
 * It also covers the deferred #118 acceptance: a past amortization plan and a
 * past balance anchor each produce historical snapshots that appear in
 * /historico at their dates.
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

test("debt model: amortizable plan + revisions, revolving anchors, future rejected, past snapshots in historico", async ({
  page,
}) => {
  // 1. Create a liability.
  await addHolding(page, {
    instrument: "mortgage",
    name: "Hipoteca Centro",
    balance: "180000",
  });

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Deuda añadida.");

  const liabilityId = new URL(page.url()).hash.slice(1);
  expect(liabilityId).toBeTruthy();

  // 2–3. Open the ficha: the header says what is owed, and the model the alta of a
  //      mortgage already set — amortizable, still without a plan.
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  const state = page.getByRole("region", { name: "Estado de la deuda" });
  await expect(state.locator(".fichaValue")).toHaveText(/−\s180\.?000\s*€/);
  await expect(state).toContainText("Amortizable (préstamo francés)");
  await expect(state).toContainText("Sin plan");
  // With no plan yet, the origin-declared plan form starts demoted inside a
  // <details> (current-state entry is the primary path, S2 #677) — expand it.
  await page.getByText("¿Tienes los datos originales del préstamo?").click();
  await expect(page.getByRole("form", { name: "Plan de amortización" })).toBeVisible();

  // 4. Declare a PAST amortization plan (firma ~6 years ago). Two dates now
  //    (ADR 0019, #189): a disbursement and a first payment. Filling the firma
  //    auto-fills the first-payment suggestion; we override it with an explicit
  //    date to pin the curve.
  const planStart = yearsAgo(6);
  const planForm = page.getByRole("form", { name: "Plan de amortización" });
  await planForm.getByLabel("Capital inicial en EUR").fill("200000");
  await planForm.getByLabel("Tipo de interés anual (%)").fill("2,5");
  await planForm.getByLabel("Plazo en meses").fill("360");
  await planForm.getByLabel("Fecha de firma").fill(planStart);
  await planForm.getByLabel("Fecha del primer pago").fill(planStart);
  await page.getByRole("button", { name: "Guardar plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Plan de amortización guardado.");
  // Persisted plan is shown back in the form, on «Plan».
  await expect(planForm.getByLabel("Fecha de firma")).toHaveValue(planStart);
  await expect(planForm.getByLabel("Fecha del primer pago")).toHaveValue(planStart);
  await expect(planForm.getByLabel("Plazo en meses")).toHaveValue("360");
  // The header now reads the curve, not the stored 180.000, and the cuota in force.
  await expect(state.locator(".fichaValue")).not.toHaveText(/180\.?000/);
  await expect(state).toContainText("Cuota vigente");

  // 5. A FUTURE firma is rejected client-side (native max=today). Editing an
  //    existing plan, the first payment is already set, so changing the firma
  //    leaves it untouched (the suggestion only tracks a blank field).
  const futureStart = planForm.getByLabel("Fecha de firma");
  await futureStart.fill(yearsAhead(1));
  expect(await futureStart.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await expect(futureStart).toHaveAttribute("max", today);
  await futureStart.fill(planStart); // restore

  // 6–7. Add an interest-rate revision (date ~3 years ago) from the bar's panel: it
  //    lands on «Revisiones», with the new row marked.
  const revisionDate = yearsAgo(3);
  const addRevision = await openFichaAction(page, "Registrar revisión de tipo");
  await addRevision.getByLabel("Fecha de la revisión").fill(revisionDate);
  await addRevision.getByLabel("Nuevo tipo de interés (%)").fill("3");
  await addRevision.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo registrada.");
  await expect(page).toHaveURL(/pesta%C3%B1a=revisiones|pestaña=revisiones/);

  const revisionTable = page.getByRole("table", { name: "Revisiones de tipo" });
  await expect(revisionTable.getByText(revisionDate)).toBeVisible();
  await expect(revisionTable.getByText("3 %")).toBeVisible();
  await expect(revisionTable.locator("tr[data-fresh]")).toContainText("nueva");

  // 8. Edit the revision's rate via its inline edit form.
  const revisionRow = page.getByRole("row", { name: new RegExp(revisionDate) });
  await revisionRow.locator("summary", { hasText: "Editar" }).click();
  const editRevision = page.getByRole("form", { name: "Editar revisión de tipo" });
  await editRevision.getByLabel("Nuevo tipo de interés (%)").fill("3,5");
  await editRevision.getByRole("button", { name: "Guardar revisión" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo actualizada.");
  await expect(revisionTable.getByText("3.5 %")).toBeVisible();

  // 9. The past plan produced historical snapshots — visible in /historico.
  //     `range=all`: since #1535 the page reads a WINDOW, and its 1A default would
  //     hide the rows this plan produced six years ago (same fix as journey 23).
  await page.goto("/historico?range=all");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();
  await expect(page.locator(".dateKey").first()).toBeVisible();
  const snapshotDates = await page.locator(".dateKey").count();
  expect(snapshotDates).toBeGreaterThan(1);

  // 10. Delete the revision, from its tab.
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  await openFichaTab(page, "Revisiones");
  const deleteRevisionRow = page.getByRole("row", { name: new RegExp(revisionDate) });
  await deleteRevisionRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteRevisionRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo eliminada.");
  await expect(
    page.getByRole("table", { name: "Revisiones de tipo" }).getByText(revisionDate),
  ).toHaveCount(0);

  // 10b. Recalibrate with the bank's real figure: it lands on «Plan» with its notice.
  const recalibrate = await openFichaAction(page, "Recalibrar con saldo real");
  await expect(recalibrate).toContainText("Saldo modelado a día de hoy");
  await recalibrate.getByLabel("Saldo real (EUR)").fill("150000");
  await recalibrate.getByLabel("Fecha de recalibración").fill(today);
  await recalibrate.getByRole("button", { name: "Recalibrar saldo" }).click();
  await expect(page.getByRole("status")).toContainText("Deuda recalibrada");
  await expect(page.getByRole("form", { name: "Plan de amortización" })).toBeVisible();
  await expect(state.locator(".fichaValue")).toHaveText(/−\s150\.?000\s*€/);

  // 11. Switch to the revolving model, from «Más». The plan tab goes, «Saldos»
  //     comes, and «Registrar saldo» is the habitual action.
  const switchModel = await openFichaAction(page, "Modelo de deuda");
  await switchModel
    .getByRole("combobox", { name: "Modelo de deuda" })
    .selectOption("revolving");
  await switchModel.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page.getByRole("status")).toHaveText("Modelo de deuda guardado.");
  await expect(page.getByRole("form", { name: "Plan de amortización" })).toHaveCount(0);
  await expect(state).toContainText("Sin saldos declarados");

  // 12. Declare a PAST balance anchor (~2 years ago) — but a FUTURE date is
  //     rejected client-side first.
  const anchorDate = yearsAgo(2);
  const addAnchor = await openFichaAction(page, "Registrar saldo");
  const futureAnchor = addAnchor.getByLabel("Fecha del saldo");
  await futureAnchor.fill(yearsAhead(1));
  expect(await futureAnchor.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await expect(futureAnchor).toHaveAttribute("max", today);
  await futureAnchor.fill(anchorDate);
  await addAnchor.getByLabel("Saldo restante en EUR").fill("15000");
  await addAnchor.getByRole("button", { name: "Registrar saldo" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo registrado.");

  const anchorTable = page.getByRole("table", { name: "Saldos declarados" });
  await expect(anchorTable.getByText(anchorDate)).toBeVisible();
  await expect(anchorTable.getByText(/15\.000/)).toBeVisible();
  await expect(anchorTable.locator("tr[data-fresh]")).toContainText("nuevo");
  await expect(state.locator(".fichaValue")).toHaveText(/−\s15\.?000\s*€/);

  // 13. Edit the anchor's balance via its inline edit form.
  const anchorRow = page.getByRole("row", { name: new RegExp(anchorDate) });
  await anchorRow.locator("summary", { hasText: "Editar" }).click();
  const editAnchor = page.getByRole("form", { name: "Editar saldo" });
  await editAnchor.getByLabel("Saldo restante en EUR").fill("14000");
  await editAnchor.getByRole("button", { name: "Guardar saldo" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo actualizado.");
  await expect(anchorTable.getByText(/14\.000/)).toBeVisible();

  // 14. The past anchor produced a historical snapshot — visible in /historico,
  //     asked for over the whole range: the anchor is two years old and the
  //     default 1A window ends before it (#1535).
  await page.goto("/historico?range=all");
  await expect(page.locator(".dateKey", { hasText: anchorDate })).toBeVisible();

  // 15. Delete the anchor (two-step confirm), on «Saldos» — the default tab.
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  const deleteAnchorRow = page.getByRole("row", { name: new RegExp(anchorDate) });
  await deleteAnchorRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteAnchorRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo eliminado.");
  await expect(
    page.getByRole("table", { name: "Saldos declarados" }).getByText(anchorDate),
  ).toHaveCount(0);
});
