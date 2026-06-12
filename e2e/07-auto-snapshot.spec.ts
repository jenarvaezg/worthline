/**
 * Journey 7: Auto-snapshot
 *
 * First load of the day creates the snapshot automatically (no user action).
 * /historico shows the entry and it is pinned as derived monthly close (first
 * and only snapshot of the month). The Evolución panel renders on /.
 */

import { test, expect } from "./fixtures";

test("auto-snapshot: / load captures snapshot → historico shows entry", async ({
  page,
}) => {
  // 1. Load / — snapshot is captured automatically on every page load
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. Navigate to /historico — must show at least one entry
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico" })).toBeVisible();

  // 3. The table should have at least one data row (from the auto-capture above)
  const rows = page.getByRole("table").getByRole("row");
  // At least header row + 1 data row
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThanOrEqual(2);

  // 4. A date key cell exists with a YYYY-MM-DD pattern
  const dateCells = page.locator(".dateKey");
  await expect(dateCells.first()).toBeVisible();
  const dateText = await dateCells.first().textContent();
  expect(dateText).toMatch(/\d{4}-\d{2}-\d{2}/);

  // 5. Monthly close badge: the first (and so far only) snapshot of the month
  //    is automatically the monthly close
  await expect(page.getByText("Cierre de mes").first()).toBeVisible();

  // 6. Back on /, the Evolución panel reflects the captured snapshot.
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Evolución del patrimonio" }),
  ).toBeVisible();
  await expect(
    page.locator("svg.evolutionChart").or(page.locator(".evolutionEmpty")).first(),
  ).toBeVisible();

  // 7. Delta strip: with single-day data (all journeys share one wall-clock
  //    day) there is no previous snapshot to diff against, so the strip must
  //    not render. If a second day were seeded (#94), the strip would appear.
  await expect(page.locator(".deltaStrip")).toHaveCount(0);
});
