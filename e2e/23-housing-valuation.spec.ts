/**
 * Journey 23: Housing valuation editing (PRD #108, slice 6).
 *
 * On a real-estate asset's /patrimonio/[id]/editar ficha the user can:
 *   - declare an annual appreciation rate (and clear it),
 *   - register a valuation anchor (market appraisal / improvement),
 *   - see the anchors listed (date desc), edit and delete them per row,
 *   - and is blocked from declaring a future-dated anchor.
 *
 * It also covers the deferred #114 acceptance: a past anchor produces a
 * historical snapshot that appears in /historico at that date.
 *
 * Since #1847 the property's ficha is the tabbed one: a flat with no cobros opens
 * on «Valoración», «Registrar tasación» is the bar's habitual action and opens in
 * the side panel, and its refusal comes back inside that panel.
 */

import { addHolding, expect, openFichaAction, test } from "./fixtures";

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
  const ficha = `/patrimonio/${assetId}/editar`;

  // 2. Open the ficha — a flat that never paid anything opens on «Valoración».
  await page.goto(ficha);
  const state = page.getByRole("region", { name: "Estado del activo" });
  await expect(state.locator(".fichaValue")).toHaveText(/200\.?000\s*€/);
  await expect(state.locator(".fichaFigures")).toContainText("Revalorización anual");
  await expect(state.locator(".fichaFigures")).toContainText("Sin revalorización");
  await expect(
    page.getByRole("region", { name: "Valoración del inmueble" }),
  ).toBeVisible();
  // «Actualizar valor» was a second door to the same fact: it is gone.
  await expect(page.getByRole("button", { name: "Actualizar valor" })).toHaveCount(0);

  // 3. Declare an annual appreciation rate of 3 %.
  await page.getByLabel("Tasa de revalorización anual (%)").fill("3");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  // Persisted value is shown back in the input, and in the header.
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("3");
  await expect(state.locator(".fichaFigures")).toContainText("3 %");

  // 4. Register a PAST market appraisal from the panel. Its date comes set to
  //    today and stays editable.
  let panel = await openFichaAction(page, "Registrar tasación");
  await expect(page).toHaveURL(/accion=tasacion/);
  await expect(panel.getByLabel("Fecha de la tasación")).toHaveValue(today);
  await expect(panel.getByLabel("Es una tasación de mercado")).not.toBeChecked();
  await panel.getByLabel("Fecha de la tasación").fill("2024-03-15");
  await panel.getByLabel("Valor de la tasación en EUR").fill("180000");
  await panel.getByLabel("Es una tasación de mercado").check();
  await panel.getByRole("button", { name: "Registrar tasación" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación registrada.");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 5. The acquisition anchor and the added anchor are listed with dates/values,
  //    the new one marked as such.
  const anchorTable = page.getByRole("table", { name: "Tasaciones" });
  await expect(anchorTable.getByText("2020-05-10")).toBeVisible();
  await expect(anchorTable.getByText(/200\.000/)).toBeVisible();
  await expect(anchorTable.getByText("2024-03-15")).toBeVisible();
  await expect(anchorTable.getByText(/180\.000/)).toBeVisible();
  await expect(
    page.getByRole("row", { name: /2024-03-15/ }).locator(".fichaFreshMark"),
  ).toHaveText("nueva");
  await expect(state.locator(".fichaFigures")).toContainText("Tasación · 15/03/2024");

  // 6. A repeated date reopens the panel with the reason inside, said once, and
  //    what was typed kept.
  panel = await openFichaAction(page, "Registrar tasación");
  await panel.getByLabel("Fecha de la tasación").fill("2024-03-15");
  await panel.getByLabel("Valor de la tasación en EUR").fill("175000");
  await panel.getByRole("button", { name: "Registrar tasación" }).click();
  await expect(page).toHaveURL(/form=anchor/);
  panel = page.getByRole("dialog", { name: "Registrar tasación" });
  const duplicate = "Ya existe un registro con esa fecha. Edítalo o bórralo en su lugar.";
  await expect(panel.getByRole("alert")).toHaveText(duplicate);
  await expect(page.getByText(duplicate)).toHaveCount(1);
  await expect(panel.getByLabel("Valor de la tasación en EUR")).toHaveValue("175000");

  // 7. A FUTURE date is rejected. Defence in depth: the date input carries a
  //    `max` of today so the browser blocks the submit client-side (the input is
  //    reported invalid and no second anchor row is ever created); the server
  //    parser also rejects it (covered by the intake unit tests). We assert the
  //    client-side guard here — the form must not submit a future date.
  const futureDate = panel.getByLabel("Fecha de la tasación");
  await futureDate.fill("2027-01-01");
  await panel.getByLabel("Valor de la tasación en EUR").fill("250000");
  await panel.getByRole("button", { name: "Registrar tasación" }).click();
  await expect(futureDate).toHaveAttribute("max", today);
  expect(await futureDate.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
    false,
  );
  await panel.getByRole("button", { name: "Cerrar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(anchorTable.getByRole("row")).toHaveCount(3); // header + acquisition + 1 anchor

  // 8. Edit the existing anchor's value via its inline edit form, on the tab.
  const anchorRow = page.getByRole("row", { name: /2024-03-15/ });
  await anchorRow.locator("summary", { hasText: "Editar" }).click();
  const editForm = page.getByRole("form", { name: "Editar tasación" });
  await editForm.getByLabel("Valor de la tasación en EUR").fill("190000");
  await editForm.getByRole("button", { name: "Guardar tasación" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación actualizada.");
  await expect(anchorTable.getByText(/190\.000/)).toBeVisible();

  // 9. The past anchor produced a historical snapshot — visible in /historico.
  await page.goto("/historico?range=all");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();
  await expect(page.locator(".dateKey", { hasText: "2024-03-15" })).toBeVisible();

  // 10. Delete the anchor (two-step confirm inside the row's <details>).
  await page.goto(ficha);
  const deleteRow = page.getByRole("row", { name: /2024-03-15/ });
  await deleteRow.locator("summary", { hasText: "Eliminar" }).click();
  await deleteRow.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasación eliminada.");
  await expect(
    page.getByRole("table", { name: "Tasaciones" }).getByText("2024-03-15"),
  ).toHaveCount(0);

  // 11. Clear the appreciation rate.
  await page.getByLabel("Tasa de revalorización anual (%)").fill("");
  await page.getByRole("button", { name: "Guardar tasa" }).click();
  await expect(page.getByRole("status")).toHaveText("Tasa de revalorización guardada.");
  await expect(page.getByLabel("Tasa de revalorización anual (%)")).toHaveValue("");
});
