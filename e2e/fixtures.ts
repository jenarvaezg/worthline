/**
 * Shared e2e test base: browser errors fail the journey.
 *
 * React reports hydration mismatches and rendering warnings through the
 * browser's error channels (uncaught page errors and console.error), so any
 * journey that triggers one — like the <title> array-children hydration bug
 * on the home — fails instead of scrolling by in the dev server logs.
 * Every spec must import { test, expect } from "./fixtures", never from
 * "@playwright/test" directly.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    const browserErrors: string[] = [];

    page.on("pageerror", (error) => {
      browserErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`console.error: ${message.text()}`);
      }
    });

    await use(page);

    expect(
      browserErrors,
      "the browser reported errors during this journey (hydration mismatches and React warnings are treated as failures)",
    ).toEqual([]);
  },
});

export { expect };

/**
 * Delay every Server Action POST by `ms`, so an optimistic mutation's result is
 * observable in the UI BEFORE the action resolves (#521, interaction-patterns §4).
 * Server actions POST to the page path carrying a `Next-Action` header; the RSC GET
 * that the post-action redirect issues is not a POST, so it is never delayed.
 * Returns an unroute fn — call it once the optimistic assertions are made so the
 * action can resolve and the redirect can land.
 */
export async function delayServerActions(
  page: import("@playwright/test").Page,
  ms: number,
): Promise<() => Promise<void>> {
  const pattern = "**/*";
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
  return () => page.unroute(pattern);
}

/**
 * A holding's row in the /patrimonio balance board (#271). Scoped by its visible
 * name so callers locate it the same way a user would — by reading the list.
 */
export function holdingRow(page: import("@playwright/test").Page, name: string) {
  return page.locator(".balanceRow", { hasText: name });
}

/**
 * Wait until React OWNS an element before interacting with it.
 *
 * Since #1229 the workspace chrome paints from the prefetched shell while the
 * route's own body streams in, so a server-rendered control is visible — and
 * clickable — before React hydrates it. Under `next dev`, where the route's
 * chunk compiles on demand, that window is hundreds of milliseconds wide; a
 * production build closes it fast enough that a person never lands in it (which
 * is why CI, serving `next start`, never saw this).
 *
 * Clicking inside the window is not harmless for a native `<details>` (ADR 0009,
 * zero-client-JS folds): the browser toggles the `open` attribute behind React's
 * back, and the later hydration reports an attribute mismatch it explicitly
 * refuses to patch up — a real `console.error` this file's fixture (rightly)
 * fails the journey on.
 *
 * React tags every host node it hydrates with an internal `__reactFiber$…`
 * property, so its presence is an EXACT per-element hydration signal. We poll
 * for that instead of sleeping: no arbitrary timeout to tune, and the wait ends
 * the moment the node is genuinely interactive.
 */
export async function waitForHydration(locator: import("@playwright/test").Locator) {
  await expect(locator).toBeAttached();
  await expect
    .poll(
      () =>
        locator.evaluate((el) =>
          Object.keys(el).some((key) => key.startsWith("__reactFiber$")),
        ),
      { message: "React never hydrated the element" },
    )
    .toBe(true);
}

/** Expand the edit page's progressive-disclosure block before using advanced forms. */
export async function openAdvancedSettings(page: import("@playwright/test").Page) {
  const advanced = page.locator("details.editAdvanced");
  await expect(advanced).toBeVisible();
  await waitForHydration(advanced);
  if (!(await advanced.evaluate((el: HTMLDetailsElement) => el.open))) {
    await advanced.getByText("Configuración avanzada", { exact: true }).click();
  }
  await expect(advanced).toHaveJSProperty("open", true);
}

/** Open a holding row's ⋯ actions popover (the menu hides Editar/Eliminar/ack). */
export async function openHoldingMenu(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.getByLabel(`Acciones para ${name}`).click();
}

/** Soft-delete a holding from the listing: open the ⋯ menu → confirm in its nested details. */
export async function deleteHolding(page: import("@playwright/test").Page, name: string) {
  await openHoldingMenu(page, name);
  const del = holdingRow(page, name).locator("details.confirmDelete");
  await del.locator("summary").click();
  await del.getByRole("button", { name: "Confirmar" }).click();
}

export async function addHolding(
  page: import("@playwright/test").Page,
  fields: {
    instrument: string;
    name?: string;
    value?: string;
    symbol?: string;
    price?: string;
    acqDate?: string;
    acqValue?: string;
    rate?: string;
    balance?: string;
  },
  submit: boolean = true,
) {
  const { expect } = await import("@playwright/test");
  await page.goto("/patrimonio/anadir/avanzado");
  await expect(page.getByRole("heading", { name: /Añadir holding/ })).toBeVisible();

  await page
    .locator(`label.addHoldingChip:has(input[value="${fields.instrument}"])`)
    .click();

  const id = fields.instrument;
  if (fields.name) await page.locator(`input[name="name_${id}"]`).fill(fields.name);
  if (fields.value) await page.locator(`input[name="value_${id}"]`).fill(fields.value);
  if (fields.symbol) await page.locator(`input[name="symbol_${id}"]`).fill(fields.symbol);
  if (fields.price) await page.locator(`input[name="price_${id}"]`).fill(fields.price);
  if (fields.acqDate)
    await page.locator(`input[name="acqDate_${id}"]`).fill(fields.acqDate);
  if (fields.acqValue)
    await page.locator(`input[name="acqValue_${id}"]`).fill(fields.acqValue);
  if (fields.rate) await page.locator(`input[name="rate_${id}"]`).fill(fields.rate);
  if (fields.balance)
    await page.locator(`input[name="balance_${id}"]`).fill(fields.balance);

  if (submit) {
    await page.getByRole("button", { name: "Añadir al patrimonio" }).click();
  }
}
