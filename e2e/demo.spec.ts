/**
 * Demo-mode journey (PRD #297, S3 #301).
 *
 * Open /demo → choose familia → the dashboard renders fictional figures with the
 * demo banner → attempting an edit is blocked with the "deshabilitado" message →
 * switching persona swaps the whole workspace → exiting the demo (#464) returns to
 * /login with the banner gone. Runs against a DEMO=1 build with a pinned clock, so
 * every figure is deterministic (see playwright.demo.config.ts).
 */
import { expect, test } from "@playwright/test";

/**
 * Warm-navigation perf guard (#617, verifies #616). Proves the demo no longer
 * pays the full persona seed on every request: the first request for a persona
 * seeds (cold), a later navigation in the same warm server process reuses the
 * cached store (warm). Runs FIRST and uses `familia` (the richest seed, ~1s) so
 * its first load is a genuine cold seed and the cold↔warm gap is wide — the
 * journey below then reuses the warmed familia. Compares the two timings as a
 * ratio (robust under machine/CI load, unlike an absolute ceiling): a
 * reseed-per-request regression makes the warm reload cost ~the cold seed again,
 * blowing the margin. Network-free — the demo seeds in memory.
 */
test("demo: warm navigation reuses the seeded workspace (no reseed per request)", async ({
  page,
}) => {
  const headline = page.locator(".headline strong").first();

  // Cold: the first request for this persona in the process pays the full seed.
  await page.goto("/demo");
  const coldStart = Date.now();
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(headline).toBeVisible();
  expect(await headline.innerText()).not.toMatch(/sin datos/i);
  const coldMs = Date.now() - coldStart;

  // Warm: re-render the same page in the same process — the per-process store
  // cache (#616) skips the seed, so this is dramatically cheaper.
  const warmStart = Date.now();
  await page.reload();
  await expect(headline).toBeVisible();
  expect(await headline.innerText()).not.toMatch(/sin datos/i);
  const warmMs = Date.now() - warmStart;

  expect(
    warmMs,
    `warm reload (${warmMs}ms) should be far cheaper than the cold seed (${coldMs}ms); ` +
      `a comparable cost means the warm path reseeded the persona`,
  ).toBeLessThan(coldMs * 0.6);
});

test("demo: landing → familia → blocked edit → switch persona", async ({ page }) => {
  // 1. The landing pitches all three personas.
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Joven" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inversor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Familia" })).toBeVisible();

  // 2. Choose familia → land in the app with fictional figures + the demo banner.
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/app$/);
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
  await expect(page).toHaveURL(/\/app$/);
  await expect(banner).toContainText("Inversor");
  // A different persona ⇒ a different headline net worth.
  const inversorNetWorth = await page.locator(".headline strong").first().innerText();
  expect(inversorNetWorth).not.toBe(familiaNetWorth);

  // 5. Exiting the demo clears the persona cookie and lands on /login — the banner
  //    is gone and the sign-in affordance is shown. (The hosted-mode "/ now hits the
  //    login wall" gate is not exercisable in the auth-less demo build.)
  await page.getByRole("button", { name: /Salir de la demo/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("note", { name: "Modo demostración" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Iniciar sesión con Google/ }),
  ).toBeVisible();
});
