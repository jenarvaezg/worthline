/**
 * Journey 1: First run — /empezar solo path
 *
 * Opens the app for the first time (empty DB), completes the solo onboarding
 * form, and chains straight into the add wizard (S4, #599) — first run is one
 * continuous path, never a drop onto an empty dashboard. The dashboard and its
 * onboarding checklist remain reachable, with a valid scope cookie.
 */

import { expect, test } from "./fixtures";

test("first run solo: empezar → add wizard, dashboard checklist still reachable", async ({
  page,
}) => {
  // 1. Fresh DB → app redirects to /empezar
  await page.goto("/app");
  await expect(page).toHaveURL(/empezar/);

  // 2. The solo card is visible
  await expect(page.getByRole("heading", { name: "Empezar solo" })).toBeVisible();

  // 3. Fill in the name and submit
  await page.getByLabel("Tu nombre").fill("TestUser");
  await page.getByRole("button", { name: "Empezar solo" }).click();

  // 4. First run chains straight into the add wizard (S4, #599) — not the dashboard.
  await expect(page).toHaveURL("/patrimonio/anadir");
  await expect(
    page.getByRole("heading", { name: "Añade algo a tu patrimonio" }),
  ).toBeVisible();

  // 4b. Individual mode: the scope selector is redundant, so it must not render —
  // household and person are the same scope here (#269). Same Shell as the dashboard.
  await expect(page.getByRole("navigation", { name: "Selector de ámbito" })).toHaveCount(
    0,
  );

  // 5. The dashboard is still reachable and shows the onboarding checklist (steps pending).
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");
  await expect(page.getByRole("region", { name: "Primeros pasos" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Primeros pasos" })).toBeVisible();
  const holdingsLink = page
    .getByRole("region", { name: "Primeros pasos" })
    .getByRole("link")
    .first();
  await expect(holdingsLink).toBeVisible();

  // 6. Cookie is set — navigating away and back keeps the scope
  await page.goto("/patrimonio");
  await expect(page).toHaveURL("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
});
