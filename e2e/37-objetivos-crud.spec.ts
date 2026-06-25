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

  // ── 5. /ajustes must NOT have the goals CRUD section ─────────────────────
  await page.goto("/ajustes");
  // "Crear objetivo" button must be absent from /ajustes (goals CRUD moved to /objetivos)
  await expect(page.getByRole("button", { name: "Crear objetivo" })).not.toBeVisible();
  // But there is a link pointing to /objetivos
  await expect(page.getByRole("link", { name: /Gestionar objetivos/ })).toBeVisible();
});
