/**
 * First-run hogar onboarding (isolated DB project)
 *
 * Fresh database → /empezar renders → fill the Crear hogar form →
 * workspace is created with 2+ members → dashboard renders with the
 * household scope.
 *
 * This spec runs in its own Playwright project with an isolated database,
 * so /empezar is reachable (no redirect to /).
 */

import { test, expect } from "./fixtures";

test("hogar onboarding: /empezar → Crear hogar → dashboard with household", async ({
  page,
}) => {
  // 1. Navigate to /empezar — fresh DB, so the onboarding page renders
  await page.goto("/empezar");
  await expect(
    page.getByRole("heading", { name: "worthline", exact: true }),
  ).toBeVisible();

  // 2. The Crear hogar form is present with a textarea for member names
  const memberNamesInput = page.getByLabel("Miembros (un nombre por línea)");
  await expect(memberNamesInput).toBeVisible();

  // 3. Fill the household members
  await memberNamesInput.fill("Ana\nJose\nLuz");

  // 4. Submit the Crear hogar form
  await page.getByRole("button", { name: "Crear hogar" }).click();

  // 5. Redirected to / — the dashboard renders
  await expect(page).toHaveURL(/\//);
  await expect(
    page.getByRole("heading", { name: "worthline", exact: true }),
  ).toBeVisible();

  // 6. The scope selector shows household + individual member scopes
  const scopeNav = page.locator("[aria-label='Selector de scope']");
  await expect(scopeNav).toBeVisible();
  const scopeButtons = scopeNav.getByRole("button");
  // household scope + 3 individual members = 4 buttons
  await expect(scopeButtons).toHaveCount(4);

  // 7. Navigate to the simple add wizard — ownership presets must appear (2+ members)
  await page.goto("/patrimonio/anadir");
  await expect(
    page.getByRole("heading", { name: "Añade algo a tu patrimonio" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Dinero/ }).check();

  const ownershipFieldset = page.getByRole("group", { name: "Reparto" });
  await expect(ownershipFieldset).toBeVisible();

  // "De los dos" even split is the simple-flow default.
  await expect(
    ownershipFieldset.getByRole("radio", { name: /De los dos/i }),
  ).toBeVisible();
});
