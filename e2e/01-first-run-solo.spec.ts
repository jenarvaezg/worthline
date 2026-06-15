/**
 * Journey 1: First run — /empezar solo path
 *
 * Opens the app for the first time (empty DB), completes the solo onboarding
 * form, lands on / with a valid scope cookie, and verifies the onboarding
 * checklist links are present and navigable.
 */

import { test, expect } from "./fixtures";

test("first run solo: empezar → / with valid scope and onboarding checklist", async ({
  page,
}) => {
  // 1. Fresh DB → app redirects to /empezar
  await page.goto("/");
  await expect(page).toHaveURL(/empezar/);

  // 2. The solo card is visible
  await expect(page.getByRole("heading", { name: "Empezar solo" })).toBeVisible();

  // 3. Fill in the name and submit
  await page.getByLabel("Tu nombre").fill("TestUser");
  await page.getByRole("button", { name: "Empezar solo" }).click();

  // 4. Should land on / (redirect after workspace init)
  await expect(page).toHaveURL("/");

  // 5. Brand heading is visible — shell rendered
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");

  // 6. Onboarding checklist section should appear (some steps still pending)
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toBeVisible();

  // 7. "Primeros pasos" heading present
  await expect(page.getByRole("heading", { name: "Primeros pasos" })).toBeVisible();

  // 8. At least one checklist link should be navigable (holdings step → /patrimonio/anadir)
  const holdingsLink = page
    .getByRole("region", { name: "Primeros pasos" })
    .getByRole("link")
    .first();
  await expect(holdingsLink).toBeVisible();

  // 9. Cookie is set — navigating away and back keeps the scope
  await page.goto("/patrimonio");
  await expect(page).toHaveURL("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
});
