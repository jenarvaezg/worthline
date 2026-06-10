/**
 * Journey 2: First run hogar — two members → ownership presets appear on create forms
 *
 * NOTE: This spec runs AFTER 01-first-run-solo.spec.ts which already initialized
 * the workspace. Since the DB is shared and workspace already exists, /empezar
 * will redirect to /. This spec therefore verifies household mode separately by
 * checking that after setup the ownership presets appear — but since we can't
 * reinit in the same DB, we verify the ownership UI through the asset create form
 * which is sensitive to workspace mode (household shows preset radios for multiple members).
 *
 * For a true hogar test, we navigate to /patrimonio/nuevo-activo and check
 * ownership inputs — the solo workspace has 1 member so no ownership grid is shown.
 * This spec documents that behavior and tests the hogar path via /ajustes (add member).
 */

import { test, expect } from "./fixtures";

test("hogar: add second member via ajustes → ownership presets appear on asset form", async ({
  page,
}) => {
  // 1. Go to ajustes to add a second member.
  // The shell h1 is always "worthline"; the first section heading is "Miembros".
  await page.goto("/ajustes");
  await expect(page.getByRole("heading", { name: "Miembros" })).toBeVisible();

  // 2. Add a second member "Socio"
  await page.getByLabel("Nuevo miembro").fill("Socio");
  await page.getByRole("button", { name: "Añadir" }).click();

  // 3. Should still be on /ajustes (redirect back) with member listed
  await expect(page).toHaveURL(/ajustes/);

  // 4. Now navigate to nuevo-activo — with 2+ members, ownership presets must appear
  await page.goto("/patrimonio/nuevo-activo");
  await expect(page.getByRole("heading", { name: "Nuevo activo" })).toBeVisible();

  // 5. Ownership fieldset must be visible with at least one preset radio
  const ownershipFieldset = page.getByRole("group", { name: "Propiedad" });
  await expect(ownershipFieldset).toBeVisible();

  // 6. The "100% ..." preset (scope member preset) is checked by default
  const scopePreset = ownershipFieldset.getByRole("radio", { name: /100%/ });
  await expect(scopePreset).toBeVisible();
  await expect(scopePreset).toBeChecked();

  // 7. "Repartir a partes iguales" preset is also present
  await expect(
    ownershipFieldset.getByRole("radio", { name: /partes iguales/i }),
  ).toBeVisible();
});
