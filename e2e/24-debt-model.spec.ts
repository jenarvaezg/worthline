/**
 * Journey 24: Debt-model editing (PRD #109, slice 10).
 *
 * On a liability's /patrimonio/[id]/editar page the user can:
 *   - choose a debt model (amortizable / revolving / informal / none),
 *   - for an amortizable debt: declare an amortization plan and manage its
 *     interest-rate revisions (create / edit / delete),
 *   - for a revolving/informal debt: declare balance anchors (create / edit /
 *     delete), listed date-desc,
 *   - and is blocked from declaring a future-dated event (native max + server).
 *
 * It also covers the deferred #118 acceptance: a past amortization plan and a
 * past balance anchor each produce historical snapshots that appear in
 * /historico at their dates.
 */

import { test, expect, addHolding, openAdvancedSettings } from "./fixtures";

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

  // 2. Open the editar page — the debt-model section must be present.
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  await openAdvancedSettings(page);
  const section = page.getByRole("region", { name: "Modelo de deuda" });
  await expect(section).toBeVisible();

  // 3. Choose the amortizable model. The plan form must then appear.
  await section.getByLabel("Modelo de deuda").selectOption("amortizable");
  await page.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page.getByRole("status")).toHaveText("Modelo de deuda guardado.");
  await openAdvancedSettings(page);
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
  await openAdvancedSettings(page);
  // Persisted plan is shown back in the form.
  await expect(planForm.getByLabel("Fecha de firma")).toHaveValue(planStart);
  await expect(planForm.getByLabel("Fecha del primer pago")).toHaveValue(planStart);
  await expect(planForm.getByLabel("Plazo en meses")).toHaveValue("360");

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

  // 6. Add an interest-rate revision (date ~3 years ago).
  const revisionDate = yearsAgo(3);
  const addRevision = page.getByRole("form", { name: "Registrar revisión de tipo" });
  await addRevision.getByLabel("Fecha de la revisión").fill(revisionDate);
  await addRevision.getByLabel("Nuevo tipo de interés (%)").fill("3");
  await page.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo registrada.");
  await openAdvancedSettings(page);

  const revisionTable = page.getByRole("table", { name: "Revisiones de tipo" });
  await expect(revisionTable.getByText(revisionDate)).toBeVisible();
  await expect(revisionTable.getByText("3 %")).toBeVisible();

  // 7. Edit the revision's rate via its inline edit form.
  const revisionRow = page.getByRole("row", { name: new RegExp(revisionDate) });
  await revisionRow.locator("summary", { hasText: "Editar" }).click();
  const editRevision = page.getByRole("form", { name: "Editar revisión de tipo" });
  await editRevision.getByLabel("Nuevo tipo de interés (%)").fill("3,5");
  await editRevision.getByRole("button", { name: "Guardar revisión" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo actualizada.");
  await openAdvancedSettings(page);
  await expect(revisionTable.getByText("3.5 %")).toBeVisible();

  // 8. The past plan produced historical snapshots — visible in /historico.
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();
  await expect(page.locator(".dateKey").first()).toBeVisible();
  const snapshotDates = await page.locator(".dateKey").count();
  expect(snapshotDates).toBeGreaterThan(1);

  // 9. Delete the revision.
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  await openAdvancedSettings(page);
  const deleteRevisionRow = page.getByRole("row", { name: new RegExp(revisionDate) });
  await deleteRevisionRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteRevisionRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Revisión de tipo eliminada.");
  await openAdvancedSettings(page);
  await expect(
    page.getByRole("table", { name: "Revisiones de tipo" }).getByText(revisionDate),
  ).toHaveCount(0);

  // 10. Switch to the revolving model. The plan form disappears, the balance
  //     anchor form appears. (Scope to the <select> by its combobox role: the
  //     "Modelo de deuda" label is shared by the section region and the select.)
  await page.getByRole("combobox", { name: "Modelo de deuda" }).selectOption("revolving");
  await page.getByRole("button", { name: "Guardar modelo" }).click();
  await expect(page.getByRole("status")).toHaveText("Modelo de deuda guardado.");
  await openAdvancedSettings(page);
  await expect(page.getByRole("form", { name: "Plan de amortización" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Registrar saldo" })).toBeVisible();

  // 11. Declare a PAST balance anchor (~2 years ago).
  const anchorDate = yearsAgo(2);
  const addAnchor = page.getByRole("form", { name: "Registrar saldo" });
  await addAnchor.getByLabel("Fecha del saldo").fill(anchorDate);
  await addAnchor.getByLabel("Saldo restante en EUR").fill("15000");
  await page.getByRole("button", { name: "Registrar saldo" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo registrado.");
  await openAdvancedSettings(page);

  const anchorTable = page.getByRole("table", { name: "Saldos declarados" });
  await expect(anchorTable.getByText(anchorDate)).toBeVisible();
  await expect(anchorTable.getByText(/15\.000/)).toBeVisible();

  // 12. A FUTURE balance date is rejected client-side.
  const futureAnchor = addAnchor.getByLabel("Fecha del saldo");
  await futureAnchor.fill(yearsAhead(1));
  expect(await futureAnchor.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await expect(futureAnchor).toHaveAttribute("max", today);

  // 13. Edit the anchor's balance via its inline edit form.
  const anchorRow = page.getByRole("row", { name: new RegExp(anchorDate) });
  await anchorRow.locator("summary", { hasText: "Editar" }).click();
  const editAnchor = page.getByRole("form", { name: "Editar saldo" });
  await editAnchor.getByLabel("Saldo restante en EUR").fill("14000");
  await editAnchor.getByRole("button", { name: "Guardar saldo" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo actualizado.");
  await openAdvancedSettings(page);
  await expect(anchorTable.getByText(/14\.000/)).toBeVisible();

  // 14. The past anchor produced a historical snapshot — visible in /historico.
  await page.goto("/historico");
  await expect(page.locator(".dateKey", { hasText: anchorDate })).toBeVisible();

  // 15. Delete the anchor (two-step confirm).
  await page.goto(`/patrimonio/${liabilityId}/editar`);
  await openAdvancedSettings(page);
  const deleteAnchorRow = page.getByRole("row", { name: new RegExp(anchorDate) });
  await deleteAnchorRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteAnchorRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Saldo eliminado.");
  await openAdvancedSettings(page);
  await expect(
    page.getByRole("table", { name: "Saldos declarados" }).getByText(anchorDate),
  ).toHaveCount(0);
});
