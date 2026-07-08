/**
 * Journey 37: Goals CRUD on /objetivos (S3 of PRD #507, issue #511)
 *
 * Verifies that goal create / edit / delete lives on /objetivos (not /ajustes).
 * Runs against the shared serial DB (workspace already initialized by earlier
 * journeys — journey 01 creates it). No demo persona: demo mode blocks mutations.
 *
 * Also asserts /ajustes no longer shows the goals CRUD section and has a link
 * to /objetivos instead.
 */
import { test, expect } from "./fixtures";

test("/objetivos: create, edit, delete a goal — CRUD lives here, not in /ajustes", async ({
  page,
}) => {
  // ── Navigate to /objetivos ────────────────────────────────────────────────
  await page.goto("/objetivos");
  await expect(page).toHaveURL(/\/objetivos/);

  // ── 1. Create form is present on /objetivos ───────────────────────────────
  await expect(page.getByRole("button", { name: "Crear objetivo" })).toBeVisible();

  // ── 2. Create a new goal ──────────────────────────────────────────────────
  // Use a stable name (no Date.now — the DB is shared and durable across the run)
  const goalName = "Fondo de emergencia e2e";
  await page.getByLabel("Nombre").last().fill(goalName);
  await page.getByLabel("Importe objetivo (EUR)").last().fill("10000");
  await page.getByLabel("Fecha límite").last().fill("2030-06-30");
  // Priority defaults to Media — leave it
  await page.getByRole("button", { name: "Crear objetivo" }).click();

  // After server-action redirect back to /objetivos the new goal should appear
  await expect(page).toHaveURL(/\/objetivos/);
  // The goals list now has an edit form. Scope to the goalRow containing our goal's
  // name input (filters by HTML [value] attribute set by defaultValue on server render).
  const createdCard = page
    .locator(".goalRow")
    .filter({ has: page.locator(`input[name="name"][value="${goalName}"]`) });
  await expect(createdCard).toBeVisible();

  // ── 3. Edit the goal ──────────────────────────────────────────────────────
  const editedName = "Fondo de emergencia e2e EDITADO";
  await createdCard.getByLabel("Nombre").fill(editedName);
  await createdCard.getByRole("button", { name: "Guardar objetivo" }).click();

  await expect(page).toHaveURL(/\/objetivos/);

  // ── 4. Delete the goal ────────────────────────────────────────────────────
  // After the server-redirect the page re-renders: the edit form's Nombre input
  // has defaultValue=editedName, so its HTML [value] attribute matches.
  const goalCard = page
    .locator(".goalRow")
    .filter({ has: page.locator(`input[name="name"][value="${editedName}"]`) });
  await goalCard.locator("details.confirmDelete summary").click();
  await goalCard.getByRole("button", { name: "Confirmar borrado" }).click();

  await expect(page).toHaveURL(/\/objetivos/);
  // After delete, no goalRow with the edited name input should exist
  await expect(
    page.locator(`input[name="name"][value="${editedName}"]`),
  ).not.toBeVisible();

  // ── 5. goal card shows FIRE delay label (S4 of PRD #507) ────────────────
  // Prepare the FIRE precondition explicitly: the serial DB can be reset by
  // earlier journeys, and a goal only reserves FIRE capital when it has an
  // assigned holding.
  await page.goto("/ajustes");
  const fireSettings = page.getByRole("region", { name: "Configuración FIRE" });
  await fireSettings.getByLabel(/^Gasto mensual/).fill("2000");
  await fireSettings.getByLabel(/^Tasa de retirada segura/).fill("4");
  await fireSettings.getByLabel(/^Retorno real esperado/).fill("5");
  await fireSettings.getByLabel(/^Edad actual/).fill("35");
  await fireSettings.getByLabel(/^Edad objetivo/).fill("65");
  await fireSettings.getByLabel(/^Ahorro mensual/).fill("1000");
  await fireSettings.getByRole("button", { name: "Guardar configuración FIRE" }).click();
  await expect(page).toHaveURL(/\/ajustes/);

  const checkGoalName = "Fondo e2e fireDelay";
  await page.goto("/objetivos");
  await page.getByLabel("Nombre").last().fill(checkGoalName);
  await page.getByLabel("Importe objetivo (EUR)").last().fill("5000");
  await page.getByLabel("Fecha límite").last().fill("2030-01-01");
  await page.locator("#goalCreateForm .chipChoice label").first().click();
  await page.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(page).toHaveURL(/\/objetivos/);

  const delayCard = page
    .locator(".goalRow")
    .filter({ has: page.locator(`input[name="name"][value="${checkGoalName}"]`) });
  await expect(delayCard).toBeVisible();

  // The card must show one of the two delay-branch labels (never «no descuenta FIRE»).
  const delayLabel = delayCard.locator(".objetivosGoalNote");
  await expect(delayLabel).toBeVisible();
  const labelText = await delayLabel.textContent();
  // Exactly one of these two: «Retrasa tu FIRE …» or «No afecta a tu FIRE»
  const isDelayBranchLabel =
    labelText?.includes("Retrasa tu FIRE") || labelText?.includes("No afecta a tu FIRE");
  expect(isDelayBranchLabel).toBe(true);
  // Explicitly exclude the out-of-horizon label (proves countsTowardFire=true path).
  expect(labelText).not.toContain("no descuenta FIRE");

  // Clean up: delete the check goal
  await delayCard.locator("details.confirmDelete summary").click();
  await delayCard.getByRole("button", { name: "Confirmar borrado" }).click();
  await expect(page).toHaveURL(/\/objetivos/);

  // ── 6. /ajustes must NOT have the goals CRUD section ─────────────────────
  await page.goto("/ajustes");
  // "Crear objetivo" button must be absent from /ajustes (goals CRUD moved to /objetivos)
  await expect(page.getByRole("button", { name: "Crear objetivo" })).not.toBeVisible();
  // But there is a link pointing to /objetivos
  await expect(page.getByRole("link", { name: /Gestionar objetivos/ })).toBeVisible();
});

test("/objetivos: create form — validation failure preserves fields and anchors to form", async ({
  page,
}) => {
  await page.goto("/objetivos");
  await expect(page).toHaveURL(/\/objetivos/);

  // Type a name but leave targetAmount blank (triggers validation error)
  const typedName = "Objetivo e2e preserve test";
  await page.getByLabel("Nombre").last().fill(typedName);
  // Intentionally leave Importe objetivo blank → "El importe objetivo debe ser un número positivo."
  await page.getByLabel("Fecha límite").last().fill("2032-12-31");

  await page.getByRole("button", { name: "Crear objetivo" }).click();

  // (a) Error message is shown (scoped to .formError to avoid Next route announcer)
  const errorBanner = page.locator(".formError[role='alert']");
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText(
    "El importe objetivo debe ser un número positivo",
  );

  // (b) Name field is preserved (not wiped)
  const nameInput = page.getByLabel("Nombre").last();
  await expect(nameInput).toHaveValue(typedName);

  // (c) URL contains the #goalCreateForm fragment so browser scrolled to the form
  expect(page.url()).toContain("#goalCreateForm");
});
