/**
 * Journey 18: Full workspace reset (issue #83) — MUST RUN LAST.
 *
 * The danger zone in /ajustes empties the entire workspace. This journey runs
 * last on purpose: it wipes the shared serial e2e database, so no later journey
 * may depend on the prior state. A wrong phrase aborts harmlessly; the exact
 * phrase resets and lands on onboarding (/empezar).
 */

import { test, expect } from "./fixtures";

test("danger zone: wrong phrase aborts, exact phrase resets to onboarding", async ({
  page,
}) => {
  await page.goto("/ajustes");

  const dangerZone = page.locator("section.dangerZone");
  await expect(dangerZone.getByRole("heading", { name: "Zona de peligro" })).toBeVisible();

  // 1. Wrong phrase → harmless abort, still on /ajustes with an error
  await dangerZone.locator("details.confirmDelete > summary").click();
  await page.getByLabel("Frase de confirmación de borrado total").fill("nope");
  await page.getByRole("button", { name: "Borrar todo definitivamente" }).click();

  await expect(page).toHaveURL(/\/ajustes/);
  await expect(dangerZone.getByText(/Escribe .* para confirmar/)).toBeVisible();

  // 2. Exact phrase → reset and redirect to onboarding
  await dangerZone.locator("details.confirmDelete > summary").click();
  await page.getByLabel("Frase de confirmación de borrado total").fill("borrar todo");
  await page.getByRole("button", { name: "Borrar todo definitivamente" }).click();

  await expect(page).toHaveURL(/\/empezar/);

  // 3. The reset workspace really is empty — visiting the dashboard also lands
  //    on onboarding instead of showing prior data.
  await page.goto("/");
  await expect(page).toHaveURL(/\/empezar/);
});
