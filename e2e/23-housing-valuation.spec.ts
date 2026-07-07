/**
 * Journey 23: Housing valuation editing (PRD #108, slice 6).
 *
 * On a real-estate asset's /patrimonio/[id]/editar page the user can:
 *   - declare an annual appreciation rate (and clear it),
 *   - add a valuation anchor (market appraisal / improvement),
 *   - see the anchors listed (date desc), edit and delete them per row,
 *   - and is blocked from declaring a future-dated anchor.
 *
 * It also covers the deferred #114 acceptance: a past anchor produces a
 * historical snapshot that appears in /historico at that date.
 */

import { test, expect, addHolding, openAdvancedSettings } from "./fixtures";

/** Today as YYYY-MM-DD — the native `max` the future-date guards advertise. */
const today = new Date().toISOString().slice(0, 10);

test("housing valuation: rate, anchor CRUD, future rejected, past snapshot in historico", async ({
  page,
}) => {
  // 1. Create a real-estate asset.
  await addHolding(page, {
    instrument: "property",
    name: "Piso Centro",
    acqDate: "2020-05-10",
    acqValue: "200000",
  });

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // The new row's anchor fragment gives us the asset id.
  const assetId = new URL(page.url()).hash.slice(1);
  expect(assetId).toBeTruthy();

  // 2. Open the editar page — the housing valuation section must be present.
  await page.goto(`/patrimonio/${assetId}/editar`);
  await openAdvancedSettings(page);
  await expect(
    page.getByRole("region", { name: "Valoración del inmueble" }),
  ).toBeVisible();

  // 3. Declare an annual appreciation rate of 3 %.
  await page.getByLabel("Tasa de revalorización anual (%)").fill("3");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  await openAdvancedSettings(page);
  // Persisted value is shown back in the input.
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("3");

  // 4. Add a PAST market-appraisal anchor. Scope to the add form (the first
  //    occurrence): each listed row also carries a hidden inline-edit form with
  //    the same field labels.
  const addForm = page.getByRole("form", { name: "Registrar tasación" });
  await addForm.getByLabel("Fecha de la tasación").fill("2024-03-15");
  await addForm.getByLabel("Valor de la tasación en EUR").fill("180000");
  await addForm.getByLabel("Es una tasación de mercado").check();
  await page.getByRole("button", { name: "Registrar tasación" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación registrada.");
  await openAdvancedSettings(page);

  // 5. The acquisition anchor and the added anchor are listed with dates/values.
  const anchorTable = page.getByRole("table", { name: "Tasaciones" });
  await expect(anchorTable.getByText("2020-05-10")).toBeVisible();
  await expect(anchorTable.getByText(/200\.000/)).toBeVisible();
  await expect(anchorTable.getByText("2024-03-15")).toBeVisible();
  await expect(anchorTable.getByText(/180\.000/)).toBeVisible();

  // 6. A FUTURE date is rejected. Defence in depth: the date input carries a
  //    `max` of today so the browser blocks the submit client-side (the input is
  //    reported invalid and no second anchor row is ever created); the server
  //    parser also rejects it (covered by the intake unit tests). We assert the
  //    client-side guard here — the form must not submit a future date.
  const futureDate = addForm.getByLabel("Fecha de la tasación");
  await futureDate.fill("2027-01-01");
  await addForm.getByLabel("Valor de la tasación en EUR").fill("250000");
  await page.getByRole("button", { name: "Registrar tasación" }).click();
  // The native max constraint blocks submission: the input is invalid and we
  // stay on the page with exactly one anchor row (the 2024-03-15 one).
  await expect(futureDate).toHaveAttribute("max", today);
  expect(await futureDate.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await expect(anchorTable.getByRole("row")).toHaveCount(3); // header + acquisition + 1 anchor

  // 7. Edit the existing anchor's value via its inline edit form. The edit
  //    affordance is a <summary>; click it by text to open the inline form.
  const anchorRow = page.getByRole("row", { name: /2024-03-15/ });
  await anchorRow.locator("summary", { hasText: "Editar" }).click();
  const editForm = page.getByRole("form", { name: "Editar tasación" });
  await editForm.getByLabel("Valor de la tasación en EUR").fill("190000");
  await editForm.getByRole("button", { name: "Guardar tasación" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación actualizada.");
  await openAdvancedSettings(page);
  await expect(anchorTable.getByText(/190\.000/)).toBeVisible();

  // 8. The past anchor produced a historical snapshot — visible in /historico.
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();
  await expect(page.locator(".dateKey", { hasText: "2024-03-15" })).toBeVisible();

  // 9. Delete the anchor (two-step confirm inside the row's <details>).
  await page.goto(`/patrimonio/${assetId}/editar`);
  await openAdvancedSettings(page);
  const deleteRow = page.getByRole("row", { name: /2024-03-15/ });
  await deleteRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación eliminada.");
  await openAdvancedSettings(page);
  await expect(
    page.getByRole("table", { name: "Tasaciones" }).getByText("2024-03-15"),
  ).toHaveCount(0);

  // 10. Clear the appreciation rate.
  await page.getByLabel("Tasa de revalorización anual (%)").fill("");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  await openAdvancedSettings(page);
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("");
});
