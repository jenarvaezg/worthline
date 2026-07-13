/**
 * Journey 45: «Libro mayor» slice 2 — Tabla/lista (#907).
 *
 * The tabular surfaces (/historico and /patrimonio) drop their floating cards for
 * open reglada sections, and adopt the accounting notation: the Pasivos column
 * wears the vertical debit rule, totals wear the double underline, debt figures
 * stay in ink (red is reserved for movement), and rows band like ledger paper.
 * Guards the canon (docs/design-system.md §3–§6) the captures (#826) sign off.
 */

import { addHolding, expect, test } from "./fixtures";

const DEBIT_RULE = "rgb(160, 58, 40)"; // --debit-rule #a03a28
const INK = "rgb(28, 36, 32)"; // --ink #1c2420
const TRANSPARENT = "rgba(0, 0, 0, 0)";

test("patrimonio board is an open ledger with the debit rule and double-rule totals", async ({
  page,
}) => {
  // One holding is enough: both panes always render (the empty pane shows a
  // "Sin deudas." line), so the structural notation is present regardless.
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo Libro Mayor",
    price: "120",
  });

  await page.goto("/patrimonio");
  await expect(page.getByRole("region", { name: "Activos y pasivos" })).toBeVisible();

  // Panes are open sheets: no card fill, no elevation.
  const assetStyle = await page.locator(".balancePaneAsset").evaluate((el) => {
    const s = getComputedStyle(el);
    return { backgroundColor: s.backgroundColor, boxShadow: s.boxShadow };
  });
  expect(assetStyle).toEqual({ backgroundColor: TRANSPARENT, boxShadow: "none" });

  // The Pasivos column carries the continuous debit rule (canon §4).
  const debitStyle = await page.locator(".balancePaneDebt").evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      backgroundColor: s.backgroundColor,
      borderLeftColor: s.borderLeftColor,
      borderLeftWidth: s.borderLeftWidth,
      boxShadow: s.boxShadow,
    };
  });
  expect(debitStyle).toEqual({
    backgroundColor: TRANSPARENT,
    borderLeftColor: DEBIT_RULE,
    borderLeftWidth: "2px",
    boxShadow: "none",
  });

  // Patrimonio neto wears the contable double underline (two 1px ink rules).
  const netRule = await page
    .locator(".balanceReconNet .balanceReconValue.totalRule")
    .evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return { backgroundImage: after.backgroundImage, height: after.height };
    });
  expect(netRule.height).toBe("4px");
  expect(netRule.backgroundImage).toContain("linear-gradient");
  expect(netRule.backgroundImage.match(/rgb\(28, 36, 32\)/g)).toHaveLength(4);

  // The kebab is the bare glyph — no bordered circle (canon §5).
  const kebabBorder = await page
    .locator(".balanceActions > summary")
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(kebabBorder).toBe("0px");
});

test("historico is an open reglada section on a ≤880px measure", async ({ page }) => {
  await page.goto("/historico");

  const section = page.getByRole("region", { name: "Histórico de snapshots" });
  await expect(section).toBeVisible();

  const style = await section.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      backgroundColor: s.backgroundColor,
      borderRadius: s.borderRadius,
      borderTopStyle: s.borderTopStyle,
      borderTopWidth: s.borderTopWidth,
      boxShadow: s.boxShadow,
    };
  });
  expect(style).toEqual({
    backgroundColor: TRANSPARENT,
    borderRadius: "0px",
    borderTopStyle: "solid",
    borderTopWidth: "2px",
    boxShadow: "none",
  });
  // The heavy opening rule prints in ink.
  expect(await section.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(INK);

  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(881);
});
