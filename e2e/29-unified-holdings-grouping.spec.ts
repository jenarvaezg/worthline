/**
 * Journey 29: The unified Patrimonio list (PRD #146, slice S8, #154).
 *
 * One list contains every live holding. Investments are NORMAL, fully-actionable
 * rows — no read-only "gestionado en Inversiones →" / ghost rows anywhere. The
 * row reaches the ficha to edit and offers delete like any holding; only its
 * VALUE stays derived (units × price, ADR 0006). The list groups/filters by
 * direction (Activos/Pasivos, default), by rung (liquidity ladder) and by
 * instrument — all server-rendered via the `?group=` query param (ADR 0009).
 */

import { test, expect, addHolding } from "./fixtures";

test("unified list: investment row is actionable (not a ghost) + grouping by direction/rung/instrument", async ({
  page,
}) => {
  // 1. Add an investment via the kept add route (S5 #151 untouched).
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo Unificado S8",
    price: "50",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. Default grouping is by direction: the "Activos" group heading is present.
  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Activos" })).toBeVisible();

  const invRow = page.getByRole("row", { name: /Fondo Unificado S8/ });
  await expect(invRow).toBeVisible();

  // 3. The investment row is FIRST-CLASS: it has the same actions as any holding —
  //    an Editar link to its ficha AND an Eliminar control. It is NOT a ghost.
  await expect(invRow.getByRole("link", { name: "Editar" })).toBeVisible();
  await expect(invRow.getByText("Eliminar")).toBeVisible();
  // The name links to the ficha (the single place a holding is managed since S6).
  await expect(invRow.getByRole("link", { name: "Fondo Unificado S8" })).toHaveAttribute(
    "href",
    /\/patrimonio\/.+\/editar/,
  );

  // 4. NO read-only ghost treatment remains anywhere on the page.
  await expect(page.getByText(/gestionado en Inversiones/i)).toHaveCount(0);
  await expect(page.getByText(/ver ficha →/i)).toHaveCount(0);

  // 5. The Editar link reaches the ficha and the investment is editable/manageable
  //    there (the derived operations surface, not a ghost dead-end).
  await invRow.getByRole("link", { name: "Editar" }).click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();

  // 6. Group by RUNG: the liquidity-ladder groups render; "Mercado" holds the fund
  //    (a market-rung instrument). The grouping is the filter, server-rendered.
  await page.goto("/patrimonio?group=rung");
  const grupoControls = page.getByRole("navigation", { name: "Agrupar holdings" });
  await expect(grupoControls.getByRole("link", { name: "Liquidez" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const mercado = page.getByRole("region", { name: "Mercado" });
  await expect(mercado).toBeVisible();
  await expect(mercado.getByRole("row", { name: /Fondo Unificado S8/ })).toBeVisible();

  // 7. Group by INSTRUMENT: the fund's instrument group ("Fondo") renders and
  //    holds the investment as an actionable row.
  await page.goto("/patrimonio?group=instrument");
  await expect(grupoControls.getByRole("link", { name: "Instrumento" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const fondo = page.getByRole("region", { name: "Fondo", exact: true });
  await expect(fondo).toBeVisible();
  const fondoRow = fondo.getByRole("row", { name: /Fondo Unificado S8/ });
  await expect(fondoRow).toBeVisible();
  await expect(fondoRow.getByRole("link", { name: "Editar" })).toBeVisible();
});
