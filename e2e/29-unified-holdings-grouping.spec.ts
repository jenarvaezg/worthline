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

import { test, expect, addHolding, holdingRow, openHoldingMenu } from "./fixtures";

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

  // 2. Default grouping is by direction: the "Activos" pane heading is present.
  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Activos" })).toBeVisible();

  const invRow = holdingRow(page, "Fondo Unificado S8");
  await expect(invRow).toBeVisible();

  // 3. The investment row is FIRST-CLASS: it has the same actions as any holding —
  //    an Editar link to its ficha AND an Eliminar control inside its ⋯ menu (#271).
  //    It is NOT a ghost. The name link to the ficha is always visible.
  await expect(invRow.getByRole("link", { name: "Fondo Unificado S8" })).toHaveAttribute(
    "href",
    /\/patrimonio\/.+\/editar/,
  );
  await openHoldingMenu(page, "Fondo Unificado S8");
  await expect(invRow.getByRole("link", { name: "Editar" })).toBeVisible();
  await expect(invRow.getByText("Eliminar")).toBeVisible();

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

  // 6. Group by RUNG: the liquidity-ladder subsections render; "Mercado" holds the
  //    fund (a market-rung instrument). The grouping is the filter, server-rendered.
  await page.goto("/patrimonio?group=rung");
  const grupoControls = page.getByRole("navigation", { name: "Agrupar holdings" });
  await expect(grupoControls.getByRole("link", { name: "Liquidez" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".balanceSubLabel", { hasText: "Mercado" })).toBeVisible();
  await expect(holdingRow(page, "Fondo Unificado S8")).toBeVisible();

  // 7. Group by INSTRUMENT: the fund's instrument subsection ("Fondo") renders and
  //    holds the investment as an actionable row.
  await page.goto("/patrimonio?group=instrument");
  await expect(grupoControls.getByRole("link", { name: "Instrumento" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".balanceSubLabel", { hasText: "Fondo" })).toBeVisible();
  await expect(holdingRow(page, "Fondo Unificado S8")).toBeVisible();
  await openHoldingMenu(page, "Fondo Unificado S8");
  await expect(
    holdingRow(page, "Fondo Unificado S8").getByRole("link", { name: "Editar" }),
  ).toBeVisible();
});
