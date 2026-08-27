/**
 * Journey 52 (#1311): a refused mutation always says WHY, even when a navigation
 * lands while the action is in flight.
 *
 * This is the sentinel for the defect #1311 recorded in CI over months and could
 * never reproduce locally: a validation error whose reason never reached the
 * screen, leaving an emptied form and no explanation while the server had
 * already refused the write and said why.
 *
 * The mechanism, read in Next 16.3's client runtime: a rejection delivered by
 * `redirect()` rides on the state the server-action reducer returns, and
 * `dispatchAction` marks a pending action `discarded` — never applying that
 * state — the moment an `ACTION_NAVIGATE` or `ACTION_RESTORE` arrives. The one
 * recovery is gated on `didRevalidate`, which a rejection (having mutated
 * nothing) never sets. So the reason was irrecoverable BY DESIGN, and only a
 * loaded CI runner opened the window wide enough to see it.
 *
 * The second test below closes that window ON PURPOSE — it pushes a history
 * entry while the action is held — which turns a ~2,7 %-per-run flake into a
 * deterministic check. Before the fix it fails every single time; the record
 * terminal is now split (success redirects, a rejection is returned as state,
 * `formActionInlineError`), so there is no navigation left to lose.
 */

import {
  addHolding,
  delayServerActions,
  expect,
  openAdvancedSettings,
  test,
} from "./fixtures";

const REFUSAL = "Las unidades son obligatorias.";

/** Reach a fresh investment's ficha with the record form primed to be refused. */
async function primeRefusedOperation(
  page: import("@playwright/test").Page,
  name: string,
) {
  await addHolding(page, { instrument: "fund", name, price: "100" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await page.goto("/patrimonio");
  await page.getByRole("link", { name }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);

  const form = page.getByRole("form", { name: "Registrar operación" });
  // Price typed, units left empty: the server refuses, and there is no buildable
  // optimistic row — the exact submit shape #1311 lost.
  await form.getByLabel("Precio por unidad en EUR").fill("105,50");
  await form.getByLabel("Unidades").clear();
  return form;
}

test("a refused operation says why in place, without navigating", async ({ page }) => {
  const form = await primeRefusedOperation(page, "Terminal Directo");

  await form.getByRole("button", { name: "Registrar operación" }).click();

  const band = page.locator("#operation-error");
  await expect(band).toBeVisible();
  await expect(band).toHaveText(REFUSAL);
  // No navigation happened, and these three are what that buys the person: the
  // typed amounts never reach the address bar, the block they opened stays open,
  // and what they typed is still in the field.
  await expect(page).not.toHaveURL(/error=/);
  await expect(page.locator("details.editAdvanced")).toHaveJSProperty("open", true);
  await expect(form.getByLabel("Precio por unidad en EUR")).toHaveValue("105,50");
});

test("the refusal survives a navigation landing while the action is in flight", async ({
  page,
}) => {
  const form = await primeRefusedOperation(page, "Terminal Pisado");

  // Hold the action so the navigation lands squarely inside its flight window —
  // what a loaded 2-vCPU runner does by accident, done on purpose.
  const release = await delayServerActions(page, 1500);
  await form.getByRole("button", { name: "Registrar operación" }).click();
  // `replaceState` is what Next patches to dispatch `ACTION_RESTORE`, so this is
  // the app's own view-state islands (§3) reproduced: any of them firing during a
  // submit used to be enough to discard the terminal.
  await page.evaluate(() => {
    window.history.replaceState(null, "", window.location.href);
  });
  await release();

  const band = page.locator("#operation-error");
  await expect(band).toBeVisible();
  await expect(band).toHaveText(REFUSAL);
});
