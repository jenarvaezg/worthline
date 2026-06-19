/**
 * Demo-mode journey (PRD #297, S3 #301).
 *
 * Open /demo → choose familia → the dashboard renders fictional figures with the
 * demo banner → attempting an edit is blocked with the "deshabilitado" message →
 * switching persona swaps the whole workspace. Runs against a DEMO=1 build with a
 * pinned clock, so every figure is deterministic (see playwright.demo.config.ts).
 */
import { expect, test } from "@playwright/test";

test("demo: landing → familia → blocked edit → switch persona", async ({ page }) => {
  // 1. The landing pitches all three personas.
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Joven" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inversor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Familia" })).toBeVisible();

  // 2. Choose familia → land in the app with fictional figures + the demo banner.
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/$/);
  const banner = page.getByRole("note", { name: "Modo demostración" });
  await expect(banner).toContainText("datos ficticios");
  await expect(banner).toContainText("Familia");
  // The five-rung ladder is populated — Vivienda is familia's housing rung.
  await expect(
    page.getByLabel("Liquidez por capa").getByText("Vivienda", { exact: true }),
  ).toBeVisible();
  const familiaNetWorth = await page.locator(".headline strong").first().innerText();
  expect(familiaNetWorth).not.toMatch(/sin datos/);

  // 3. Attempting an edit is blocked with the demo message — and the irreversible
  //    affordances are not even offered.
  await page.goto("/ajustes");
  await expect(page.getByText("Zona de peligro")).toHaveCount(0);
  await page.getByRole("button", { name: "Guardar configuración FIRE" }).click();
  await expect(page.getByText(/deshabilitada en la demo/i)).toBeVisible();

  // 4. Switching persona swaps the whole workspace.
  await page.getByRole("link", { name: /cambiar persona/ }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.getByRole("button", { name: /Inversor/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(banner).toContainText("Inversor");
  // A different persona ⇒ a different headline net worth.
  const inversorNetWorth = await page.locator(".headline strong").first().innerText();
  expect(inversorNetWorth).not.toBe(familiaNetWorth);
});
