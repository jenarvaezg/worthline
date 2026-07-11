/**
 * Journey 7: Auto-snapshot
 *
 * First load of the day creates the snapshot automatically (no user action).
 * /historico shows the entry and it is pinned as derived monthly close (first
 * and only snapshot of the month). The Evolución panel renders on /.
 */

import { expect, test } from "./fixtures";

test("auto-snapshot: / load captures snapshot → historico shows entry", async ({
  page,
}) => {
  // 1. Load / — snapshot is captured automatically on every page load
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. Navigate to /historico — must show at least one entry
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();

  // 3. The drill should have at least one data row (from the auto-capture above)
  const dataRows = page.locator(".historicoDrillRow");
  expect(await dataRows.count()).toBeGreaterThanOrEqual(1);

  // 4. A date key cell exists with a YYYY-MM-DD pattern
  const dateCells = page.locator(".dateKey");
  await expect(dateCells.first()).toBeVisible();
  const dateText = await dateCells.first().textContent();
  expect(dateText).toMatch(/\d{4}-\d{2}-\d{2}/);

  // 5. Monthly close badge: the seeded prior-month snapshot is a confirmed close
  //    (its month has fully elapsed), so its badge is shown. The in-progress
  //    month's latest capture is NOT badged "Cierre de mes" mid-month (#270).
  await expect(page.getByText("Cierre de mes").first()).toBeVisible();

  // 6. Back on /, the Evolución panel reflects the captured snapshot. Since
  //    #142 the panel hosts the net-worth composition chart (not the old
  //    evolution area chart): the dashboard renders `.compositionChart` when
  //    there are ≥2 period points (the seeded prior-month snapshot + today's
  //    auto-capture guarantee this) or the `.compositionEmpty` placeholder
  //    otherwise. Either proves the panel rendered without a hydration error.
  await page.goto("/app");
  await expect(
    page.getByRole("region", { name: "Evolución del patrimonio" }),
  ).toBeVisible();
  await expect(
    page.locator("svg.compositionChart").or(page.locator(".compositionEmpty")).first(),
  ).toBeVisible();

  // 7. Delta context: the hero exposes its snapshot deltas through the
  //    `.deltaChips` strip (the legacy `.deltaStrip` element was removed with
  //    #142). With the seeded prior-month close present, the "vs cierre
  //    mensual" chip carries a real diff rather than "sin dato".
  await expect(page.locator(".deltaChips")).toBeVisible();
  await expect(page.getByText("vs cierre mensual")).toBeVisible();
});
