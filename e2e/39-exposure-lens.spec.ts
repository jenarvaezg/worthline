/**
 * Journey 39: Exposure geography lens toggle as client state (PRD #539 S3, #543)
 *
 * The /patrimonio exposure section shows the portfolio's geography look-through
 * behind a lens toggle: "Cartera completa" ↔ "Solo renta variable". The server
 * pre-renders BOTH `lookThroughExposure` results; the client only picks which is
 * shown, so toggling costs no round-trip (interaction-patterns §2), mirrors the
 * lens to the URL via `history.pushState` (§3), updates `aria-current` (§8),
 * and Back restores it via `popstate`.
 *
 * The serial no-login suite seeds only a cash holding, which is not-applicable
 * for geography (no classified exposure), so this asserts the toggle MECHANICS —
 * URL + aria + no document reload + Back — which hold regardless of the figures
 * (#543 acceptance). A sentinel planted on `window` survives a client switch but
 * a real document navigation would wipe it.
 */

import { test, expect } from "./fixtures";

test("Exposure lens toggles client-side, mirrors the URL, no document reload", async ({
  page,
}) => {
  await page.goto("/patrimonio");

  const section = page.getByRole("region", { name: "Exposición" });
  const tabs = section.getByRole("navigation", { name: "Lente de exposición" });
  const all = tabs.getByRole("link", { name: "Cartera completa" });
  const equity = tabs.getByRole("link", { name: "Solo renta variable" });

  // Starts on the full portfolio: that tab is current, the URL carries no `exp`.
  await expect(all).toHaveAttribute("aria-current", "true");
  await expect(equity).not.toHaveAttribute("aria-current", "true");
  await expect(page).not.toHaveURL(/exp=equity/);

  // Plant a sentinel — a full document navigation would wipe it.
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });

  await equity.click();

  // Instant client switch: URL mirrors exp=equity, tabs flip their state, and the
  // sentinel survives → no document navigation happened.
  await expect(page).toHaveURL(/[?&]exp=equity/);
  await expect(equity).toHaveAttribute("aria-current", "true");
  await expect(all).not.toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  // Back restores the full portfolio via popstate — also without a reload.
  await page.goBack();
  await expect(page).not.toHaveURL(/exp=equity/);
  await expect(all).toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("Exposure lens deep-link renders the equity lens server-side", async ({ page }) => {
  await page.goto("/patrimonio?exp=equity");

  const tabs = page
    .getByRole("region", { name: "Exposición" })
    .getByRole("navigation", { name: "Lente de exposición" });
  await expect(tabs.getByRole("link", { name: "Solo renta variable" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("Exposure lens is keyboard-operable (§8)", async ({ page }) => {
  await page.goto("/patrimonio");

  const equity = page
    .getByRole("region", { name: "Exposición" })
    .getByRole("navigation", { name: "Lente de exposición" })
    .getByRole("link", { name: "Solo renta variable" });

  await equity.focus();
  await expect(equity).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/[?&]exp=equity/);
  await expect(equity).toHaveAttribute("aria-current", "true");
});
