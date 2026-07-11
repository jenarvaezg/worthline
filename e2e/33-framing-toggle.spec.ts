/**
 * Journey 33: Vista framing toggle as client state (#518, ADR 0036, Phase 0 S2)
 *
 * The Vista toggle (net worth ↔ liquid) used to be a server `<Link>` — each click
 * a full document navigation paying the ~2.3s Turso round-trip measured in the
 * S0 baseline (#516). S2 makes it an island: the server sends BOTH framings, the
 * client switches instantly, mirrors `view` to the URL via `history.pushState`,
 * and Back/Forward + deep-links still work.
 *
 * The contract is behavioural (interaction-patterns §2/§3): clicking reframes the
 * headline WITHOUT a document navigation (a sentinel planted on `window` survives
 * a client switch but a real reload would wipe it), the URL mirrors the choice,
 * and the Back button restores it. The headline label is scoped to `.headline`
 * because the liquid figure also surfaces as a breakdown stat in the total view.
 */

import { expect, test } from "./fixtures";

test("Vista toggle switches framing client-side, mirrors the URL, no document reload", async ({
  page,
}) => {
  await page.goto("/app");

  const hero = page.getByRole("region", { name: "Resumen patrimonial" });
  const tabs = hero.getByRole("navigation", { name: "Vista de patrimonio" });
  const neto = tabs.getByRole("link", { name: "Patrimonio neto" });
  const liquido = tabs.getByRole("link", { name: "Líquido" });
  const headline = hero.locator(".headline");

  // Starts on net worth: that tab is current and the headline reads "Neto total".
  await expect(neto).toHaveAttribute("aria-current", "true");
  await expect(headline).toContainText("Neto total");

  // Plant a sentinel — a full document navigation would wipe it.
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });

  await liquido.click();

  // Instant client switch: headline reframes, URL mirrors view=liquid, tab flips,
  // and crucially the sentinel survives → no document navigation happened.
  await expect(headline).toContainText("Neto liquido");
  await expect(page).toHaveURL(/[?&]view=liquid/);
  await expect(liquido).toHaveAttribute("aria-current", "true");
  await expect(neto).not.toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  // Sibling server-nav links (the donut drill segments) re-sync to the live
  // framing, so a later navigation keeps Líquido (interaction-patterns §3).
  expect(
    await page.locator('.liquidityPanel a[href*="view=liquid"]').count(),
  ).toBeGreaterThan(0);

  // Back restores net worth via popstate — also without a reload.
  await page.goBack();
  await expect(page).not.toHaveURL(/view=liquid/);
  await expect(headline).toContainText("Neto total");
  await expect(neto).toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("Vista deep-link renders the liquid framing server-side", async ({ page }) => {
  await page.goto("/?view=liquid");

  const hero = page.getByRole("region", { name: "Resumen patrimonial" });
  await expect(hero.locator(".headline")).toContainText("Neto liquido");
  await expect(
    hero
      .getByRole("navigation", { name: "Vista de patrimonio" })
      .getByRole("link", { name: "Líquido" }),
  ).toHaveAttribute("aria-current", "true");
});

test("Vista toggle is keyboard-operable (§8)", async ({ page }) => {
  await page.goto("/app");

  const liquido = page
    .getByRole("region", { name: "Resumen patrimonial" })
    .getByRole("navigation", { name: "Vista de patrimonio" })
    .getByRole("link", { name: "Líquido" });

  await liquido.focus();
  await expect(liquido).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/[?&]view=liquid/);
  await expect(liquido).toHaveAttribute("aria-current", "true");
});
