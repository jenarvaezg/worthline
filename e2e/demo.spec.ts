/**
 * Demo-mode journey (PRD #297, S3 #301).
 *
 * Open /demo → choose familia → the dashboard renders fictional figures with the
 * demo banner → attempting an edit is blocked with the "deshabilitado" message →
 * switching persona swaps the whole workspace → exiting the demo (#464) returns to
 * /login with the banner gone. Runs against a DEMO=1 build with a pinned clock, so
 * every figure is deterministic (see playwright.demo.config.ts).
 */
import { expect } from "@playwright/test";

import { visibilityScopedTest as test, wholeDocument } from "./visible-page";

/** The cookie `/demo/persona` sets; putting it in place skips the picker. */
const PERSONA_COOKIE = "wl_demo_persona";

/**
 * Warm-navigation perf guard (#617, verifies #616; rewritten in #1299). Proves
 * the demo does not pay the full persona seed on every request: the first
 * request for a persona seeds it, and every later request in the same process
 * reuses the cached store.
 *
 * #1229 (Cache Components + Partial Prefetching) broke the original guard twice
 * over, and both traps are worth naming because either one alone turns this into
 * a test that passes without proving anything:
 *
 *  1. **It waited for the shell, not for the figure.** `/app` is partially
 *     prerendered now: the static shell already paints an EMPTY
 *     `<strong class="skeletonFigure">` inside `.headline`, so a `.headline
 *     strong` locator was satisfied — visible, and no «sin datos» text — before
 *     the store was ever read. The locator below matches only the streamed
 *     figure, and `toHaveText` fails loudly if that class ever goes away instead
 *     of quietly timing an empty paint again.
 *  2. **It compared two different operations.** Picking the persona is a
 *     client-side navigation; `reload()` is a full document load with the
 *     service worker and every asset. While the seed cost ~1s that gap was
 *     buried; once trap 1 removed the seed from the measurement, all the guard
 *     compared was nav-vs-reload, and it failed on a green tree (cold 116 ms,
 *     warm 712 ms locally; 422/3040 in CI).
 *
 * So both measurements here are the SAME operation — a document load of `/app`
 * with the persona cookie already set — taken after a throwaway load that pays
 * for the browser cache, the route's first render and the familia seed. The only
 * difference left between them is whether the process still has to seed.
 * `inversor` is the cold side: with everything else warm its seed still costs
 * ~680 ms against ~30 ms warm (measured against the production build), and that
 * margin is what keeps the ratio robust under CI load. The throwaway load also
 * leaves familia warm for the journey below. Network-free — seeds in memory.
 */
test("demo: warm navigation reuses the seeded workspace (no reseed per request)", async ({
  baseURL,
  context,
  page,
}) => {
  // The streamed figure — never the shell's `.skeletonFigure` placeholder.
  const figure = page.locator(".headline strong.totalRule").first();

  const loadApp = async (persona: string): Promise<number> => {
    await context.addCookies([
      { name: PERSONA_COOKIE, url: String(baseURL), value: persona },
    ]);
    const startedAt = Date.now();
    await page.goto("/app");
    await expect(figure).toHaveText(/\d.*€/);
    return Date.now() - startedAt;
  };

  await loadApp("familia");

  const warmMs = await loadApp("familia");
  const coldMs = await loadApp("inversor");

  expect(
    warmMs,
    `an already-seeded persona (${warmMs}ms) should be far cheaper than one the ` +
      `process must still seed (${coldMs}ms); a comparable cost means the warm ` +
      `path reseeded the persona`,
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
  // «Not even offered» means never rendered, so ask the document: a screen-scoped
  // count would also pass for a danger zone tucked inside a closed fold (#1351).
  await expect(wholeDocument(page).getByText("Zona de peligro")).toHaveCount(0);
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
  //    login wall" gate is not exercisable in the auth-less demo build.) In local
  //    no-auth mode Google is disabled and the local entry leads into the app.
  await page.getByRole("button", { name: /Salir de la demo/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("note", { name: "Modo demostración" })).toHaveCount(0);
  const googleButton = page.getByRole("button", { name: /Iniciar sesión con Google/ });
  await expect(googleButton).toBeVisible();
  await expect(googleButton).toBeDisabled();
  const localEntry = page.getByRole("link", { name: /Sesión local/ });
  await expect(localEntry).toBeVisible();
  await localEntry.click();
  await expect(page).toHaveURL(/\/app$/);
});
