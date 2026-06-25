/**
 * Journey 36: /objetivos page
 *
 * From home, navigate to the Objetivos page via the «Ver objetivos →» link
 * and via the nav entry. Assert the FIRE star hero and goals list (or empty
 * state) render, and that the active nav item is "Objetivos".
 *
 * Uses the familia persona — it has a configured FIRE target.
 */
import { expect, test } from "@playwright/test";

test("/objetivos: FIRE hero + goals section render, nav active", async ({ page }) => {
  // Choose the familia persona (has FIRE configured).
  await page.goto("/demo");
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/$/);

  // 1. «Ver objetivos →» link on the home FIRE glance card points to /objetivos.
  const verLink = page.getByRole("link", { name: /Ver objetivos/ });
  await expect(verLink).toBeVisible();
  await expect(verLink).toHaveAttribute("href", "/objetivos");

  // 2. Navigate via the link.
  await verLink.click();
  await expect(page).toHaveURL(/\/objetivos/);

  // 3. FIRE star hero region renders.
  const fireSection = page.getByRole("region", { name: "FIRE", exact: true });
  await expect(fireSection).toBeVisible();

  // 4. Goals section renders (empty state or goal cards).
  const goalsSection = page.getByRole("region", { name: "Objetivos" });
  await expect(goalsSection).toBeVisible();

  // 5. Active nav item is "Objetivos".
  const nav = page.getByRole("navigation", { name: "Secciones principales" });
  await expect(nav.getByRole("link", { name: "Objetivos" })).toHaveClass(/active/);

  // 6. Navigate back to home and use the top-nav "Objetivos" entry directly.
  await page.goto("/demo");
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/$/);

  await page
    .getByRole("navigation", { name: "Secciones principales" })
    .getByRole("link", { name: "Objetivos" })
    .click();
  await expect(page).toHaveURL(/\/objetivos/);
  await expect(page.getByRole("region", { name: "FIRE", exact: true })).toBeVisible();
});

test("/objetivos: Niveles FIRE rail renders Coast/Lean/Regular/Fat labels", async ({
  page,
}) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/objetivos");

  const rail = page.getByRole("region", { name: "Niveles FIRE" });
  await expect(rail).toBeVisible();

  for (const label of ["Coast", "Lean", "Regular", "Fat"]) {
    await expect(rail.getByText(label, { exact: true })).toBeVisible();
  }
});
