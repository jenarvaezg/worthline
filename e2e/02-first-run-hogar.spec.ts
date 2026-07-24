/**
 * First-run hogar onboarding (isolated DB project)
 *
 * Fresh database → /empezar renders → fill the Crear hogar form →
 * workspace is created with 2+ members → first run lands on the full-screen
 * onboarding (#1168), whose «a mano» escape reaches the add wizard with the
 * household scope live in the shared shell.
 *
 * This spec runs in its own Playwright project with an isolated database,
 * so /empezar is reachable (no redirect to /).
 */

import { expect, test } from "./fixtures";

test("hogar onboarding: /empezar → Crear hogar → onboarding → add wizard with household scope", async ({
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

  // 5. First run lands on the full-screen onboarding (#1168); the «a mano»
  // escape leads to the add wizard — not a drop onto the dashboard.
  await expect(page).toHaveURL("/bienvenida");
  await expect(
    page.getByRole("heading", { name: "Vamos a componer tu patrimonio." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Prefiero cargarlo a mano" }).click();
  await expect(page).toHaveURL("/patrimonio/anadir");
  await expect(
    page.getByRole("heading", { name: "Añade algo a tu patrimonio" }),
  ).toBeVisible();

  // 6. The shared shell carries the household scope here too: the scope selector
  // shows the household scope + individual member scopes.
  const scopeNav = page.locator("[aria-label='Selector de ámbito']");
  await expect(scopeNav).toBeVisible();
  const scopeButtons = scopeNav.getByRole("button");
  // household scope + 3 individual members = 4 buttons
  await expect(scopeButtons).toHaveCount(4);

  // 7. Reload the wizard for a clean interaction, then its ownership presets
  // must appear (2+ members). The drawer radio is hidden behind its styled card
  // label, so click the label (the pattern proven in 31-add-investment-saldo).
  await page.goto("/patrimonio/anadir");
  await page.locator('label.simpleDrawerCard:has(input[value="dinero"])').click();

  const ownershipFieldset = page.getByRole("group", { name: "Reparto" });
  await expect(ownershipFieldset).toBeVisible();

  // "De los dos" even split is the simple-flow default.
  await expect(
    ownershipFieldset.getByRole("radio", { name: /De los dos/i }),
  ).toBeVisible();
});
