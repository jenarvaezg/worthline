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
import { expect, test } from "./fixtures";

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
  // name input. Safe to filter by the HTML [value] attribute here: this row was
  // just server-rendered and nobody has typed into it (contrast step 4).
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
  // Reload before locating by [value]. That selector matches the HTML ATTRIBUTE,
  // and React deliberately does NOT overwrite the attribute of an input the user
  // has typed into — so after a client-side re-render the node can still carry
  // the pre-edit name even though the mutation persisted. Filtering on it was
  // this spec's flake (#1180): ~15% of runs timed out here. A fresh document also
  // makes the assertion stronger — it proves the edit reached the DB rather than
  // that the DOM happened to paint it.
  await page.reload();
  const goalCard = page
    .locator(".goalRow")
    .filter({ has: page.locator(`input[name="name"][value="${editedName}"]`) });
  await expect(goalCard).toBeVisible();
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

  // The reference age is no longer a FIRE field: it is derived from the member's
  // birth date (#1415). Without it there is no FIRE horizon, and every goal falls
  // out of it — which is exactly the «no descuenta FIRE» label this journey
  // excludes below. Set it on the first member (the household scope reads its
  // oldest member) for the same reason the FIRE config is set explicitly here:
  // an earlier journey may have reset the DB.
  const firstMember = page.locator(".memberRow").first();
  await firstMember.getByLabel(/^Año de nacimiento/).fill("1991");
  await firstMember.getByRole("button", { name: "Guardar perfil" }).click();
  // Wait for the SUCCESS param, not merely for «still on /ajustes»: the action
  // pushes a new URL and re-renders the page, and these inputs are `defaultValue`,
  // so filling the FIRE form before that navigation lands loses every value the
  // re-render replaces — the form then posts an empty monthly spending and the
  // whole FIRE config is refused. A laxer regex matches the OLD url instantly and
  // hides both the race and the refusal (which is how this passed in isolation).
  await expect(page).toHaveURL(/[?&]ok=saved/);

  // Los supuestos FIRE se editan donde se ven (#1450): el formulario vive en
  // /objetivos, no en /ajustes. Lo del miembro (el año de nacimiento de arriba) se
  // queda en Ajustes, porque es del miembro y no del FIRE.
  await page.goto("/objetivos");
  const fireSettings = page.getByRole("region", { name: "Tus supuestos" });
  await fireSettings.getByLabel(/^Gasto mensual/).fill("2000");
  await fireSettings.getByLabel(/^Tasa de retirada/).fill("4");
  await fireSettings.getByLabel(/^Edad objetivo/).fill("65");
  await fireSettings.getByLabel(/^Ahorro mensual/).fill("1000");
  // El retorno fijo vive en el pliegue de supuestos finos: cerrado, el campo existe
  // en el DOM pero no se puede rellenar.
  await fireSettings.locator("details.fireConfigFine > summary").click();
  await fireSettings.getByLabel(/^Retorno real esperado/).fill("5");
  await fireSettings.getByRole("button", { name: "Guardar supuestos" }).click();
  // Same reason, plus one more: this asserts the config was ACCEPTED. A rejected
  // form also redirects here (with `?error=…`), so the lax URL let a
  // silently-refused FIRE config through and the failure surfaced 30 lines later
  // as a goal with no FIRE horizon.
  await expect(page).toHaveURL(/[?&]ok=fire_saved/);

  // ── Editas aquí, ves ahí (#1450): el número FIRE se mueve al teclear, sin
  //    guardar y sin recargar. 2.000 €/mes al 4 % son 600.000 €; 3.000, 900.000.
  const fireNumber = page
    .getByRole("region", { name: "FIRE" })
    .locator(".fireMetric", { hasText: "Número FIRE" });
  await expect(fireNumber).toContainText("600.000");
  await fireSettings.getByLabel(/^Gasto mensual/).fill("3000");
  await expect(fireNumber).toContainText("900.000");
  // Y lo dice: unas cifras previsualizadas que no se declaran se leen como firmes.
  await expect(fireSettings.getByText(/Aún no se han guardado/)).toBeVisible();
  // La URL no ha cambiado: no ha habido navegación ni guardado.
  await expect(page).toHaveURL(/[?&]ok=fire_saved/);
  // Deshacer el borrador: lo que sigue cuenta con los 2.000 € guardados.
  await fireSettings.getByLabel(/^Gasto mensual/).fill("2000");
  await expect(fireNumber).toContainText("600.000");

  const checkGoalName = "Fondo e2e fireDelay";
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

  // ── 6. /ajustes no habla de objetivos ni de FIRE ─────────────────────────
  // Ni el CRUD (que se mudó en #511) ni sus punteros: una mudanza no deja un
  // cartel donde estaba el mueble.
  await page.goto("/ajustes");
  await expect(page.getByRole("button", { name: "Crear objetivo" })).not.toBeVisible();
  await expect(page.getByRole("link", { name: /Gestionar objetivos/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Tus supuestos" })).toHaveCount(0);
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
