/**
 * Journey 56 (#1826): the investment ficha is a state header with an action bar,
 * one action at a time in a side panel, and tabs — and what is on show lives in the
 * URL (interaction-patterns §3).
 *
 * What the skeleton promises, end to end: the tabs switch without a reload and
 * mirror `?pestaña=`, Back walks them back; an action opens alone in the panel
 * (`?accion=`) without moving the page and gives focus back when it closes (§8);
 * the links that already existed (`?abrir=operaciones|cobros|traspaso`) land where
 * they did; a form returns to the tab its result shows on; and at 390 px the four
 * tabs fit and nothing scrolls sideways.
 *
 * And adding never needs a search (#1829): scrolled anywhere, the habitual action
 * is one click away (a strip on a desktop, a button at the bottom of a phone);
 * «Añadir cobro» asks which cobro first and shows one form; and a registration
 * lands on its tab with the new row pointed at and «Añadir otra» keeping its day.
 */

import {
  addHolding,
  expect,
  holdingRow,
  openFichaAction,
  openFichaTab,
  test,
} from "./fixtures";

/** A fund with a manual price (no network) and one buy, so every action is offered. */
async function fundWithBuy(page: import("@playwright/test").Page, name: string) {
  await addHolding(page, { instrument: "fund", name, price: "100" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await page.goto("/patrimonio");
  const row = holdingRow(page, name);
  await expect(row).toBeVisible();
  await row.getByRole("link", { name }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);

  const form = (await openFichaAction(page, "Registrar operación")).getByRole("form", {
    name: "Registrar operación",
  });
  await form.getByLabel("Unidades").fill("10");
  await form.getByLabel("Precio por unidad en EUR").fill("100");
  await form.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  return new URL(page.url()).pathname;
}

/** How far the document scrolls sideways — zero when nothing overflows. */
const sidewaysOverflow = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

const bar = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Acciones del activo" });

test("the tabs switch without a reload, mirror ?pestaña= and walk back with Atrás", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Pestañas E2E");

  // No accordion left: the state and the bar are what the ficha opens with.
  await expect(page.getByText("Configuración avanzada")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Estado del activo" })).toBeVisible();
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });

  await openFichaTab(page, "Cobros");
  await expect(page).toHaveURL(/pesta%C3%B1a=cobros/);
  await expect(page.getByRole("region", { name: "Cobros" })).toContainText(
    "Renta pasiva",
  );

  await openFichaTab(page, "Datos del activo");
  await expect(page).toHaveURL(/pesta%C3%B1a=datos/);
  await expect(page.getByRole("heading", { name: "Lo básico" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Zona de peligro" })).toBeVisible();

  // Back is the URL's, so it walks the tabs back — still without a reload.
  await page.goBack();
  await expect(page).toHaveURL(/pesta%C3%B1a=cobros/);
  await expect(
    page
      .getByRole("navigation", { name: "Secciones de la ficha" })
      .getByRole("link", { name: "Cobros" }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("an action opens alone in the panel, without moving the page, and gives focus back", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Panel E2E");

  const value = page.locator(".fichaValue");
  const before = await value.boundingBox();

  const panel = await openFichaAction(page, "Registrar operación");
  await expect(page).toHaveURL(/accion=operacion/);
  // The panel overlays the page; the page under it does not move.
  expect(await value.boundingBox()).toEqual(before);
  await expect(panel).toBeFocused();

  // Esc closes it and hands focus back to the button that opened it (§8).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/accion=/);
  await expect(
    bar(page).getByRole("button", { exact: true, name: "Registrar operación" }),
  ).toBeFocused();

  // The rarer actions live behind «Más», and open the same way — one at a time.
  const statement = await openFichaAction(page, "Cargar movimientos");
  await expect(page).toHaveURL(/accion=extracto/);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await statement.getByRole("button", { name: "Cerrar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Más" })).toBeFocused();
});

test("the links that already existed land where they promised", async ({ page }) => {
  const ficha = await fundWithBuy(page, "Fondo Enlaces E2E");

  // `holdingCobrosHref` — the Cobros tab, its record on screen.
  await page.goto(`${ficha}?abrir=cobros#cobros`);
  await expect(page.getByRole("region", { name: "Cobros" })).toBeVisible();

  // `holdingOperationsHref` — the ledger.
  await page.goto(`${ficha}?abrir=operaciones#operaciones`);
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();

  // The Papelera's «Lo traspasé a…» exit (#1549) — the traspaso, open.
  await page.goto(`${ficha}?abrir=traspaso&archivar=1#traspaso`);
  await expect(page.getByRole("dialog", { name: "Traspasar" })).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Traspasar a otra inversión" }),
  ).toBeVisible();
});

test("a cobro added from the panel lands on the Cobros tab", async ({ page }) => {
  await fundWithBuy(page, "Fondo Cobro E2E");

  const panel = await openFichaAction(page, "Añadir cobro");
  // Exact: the recurring form beside it has «Importe del cobro recurrente».
  await panel.getByLabel("Importe del cobro", { exact: true }).fill("12,50");
  await panel.getByRole("button", { name: "Añadir cobro" }).click();

  await expect(page).toHaveURL(/pesta%C3%B1a=cobros.*ok=payout_saved/);
  await expect(page.getByRole("status")).toHaveText("Cobro registrado.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The record rounds its strip to the euro, so the count is the exact signal.
  await expect(page.getByRole("region", { name: "Cobros" })).toContainText("1 cobro.");
});

test("at 390 px the four tabs fit, nothing scrolls sideways, and the panel takes the screen", async ({
  page,
}) => {
  // The alta is not what this measures, so the fund is made at the default width.
  const ficha = await fundWithBuy(page, "Fondo Móvil E2E");
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(ficha);
  await expect(page.getByRole("region", { name: "Estado del activo" })).toBeVisible();

  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
  const tabs = page.getByRole("navigation", { name: "Secciones de la ficha" });
  expect(
    await tabs.evaluate((nav) => nav.scrollWidth - nav.clientWidth),
  ).toBeLessThanOrEqual(0);
  await expect(tabs.getByRole("link", { name: "Datos" })).toBeVisible();

  const panel = await openFichaAction(page, "Registrar operación");
  const box = await panel.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(390);
});

/** Far enough down «Datos del activo» that the action bar has left the screen. */
async function scrollPastTheBar(
  page: import("@playwright/test").Page,
  // At 390 px the tab reads «Datos».
  datosTab = "Datos del activo",
) {
  await openFichaTab(page, datosTab);
  await page.getByRole("heading", { name: "Zona de peligro" }).scrollIntoViewIfNeeded();
  await expect(bar(page)).not.toBeInViewport();
}

const strip = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Acciones a mano" });

test("scrolled away from the bar, the habitual action stays one click away, and steps aside for the panel (#1829)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Franja E2E");
  // At the top the bar is on screen, so there is nothing to keep at hand.
  await expect(strip(page)).toHaveCount(0);

  await scrollPastTheBar(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("Fondo Franja E2E");

  const record = strip(page).getByRole("button", {
    exact: true,
    name: "Registrar operación",
  });
  await record.click();
  await expect(page.getByRole("dialog", { name: "Registrar operación" })).toBeVisible();
  // Never on top of the panel it opened.
  await expect(strip(page)).toHaveCount(0);

  // Closed, the strip is back and the button that opened the panel has focus (§8).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(record).toBeFocused();

  // Its «Más» carries every other action, «Traspasar» included.
  await strip(page).getByRole("button", { name: "Más" }).click();
  await strip(page).getByRole("button", { exact: true, name: "Traspasar" }).click();
  await expect(page.getByRole("dialog", { name: "Traspasar" })).toBeVisible();
  await expect(page).toHaveURL(/accion=traspaso/);
});

test("on a phone the habitual action waits at the bottom, clear of the assistant's launcher (#1829)", async ({
  page,
}) => {
  const ficha = await fundWithBuy(page, "Fondo Botón E2E");
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(ficha);
  await expect(page.getByRole("region", { name: "Estado del activo" })).toBeVisible();
  await scrollPastTheBar(page, "Datos");

  // One button, not the desktop strip: no name, no value, no «Más».
  await expect(strip(page).getByRole("button")).toHaveCount(1);
  const cta = strip(page).getByRole("button", { name: "Registrar operación" });
  await expect(cta).toBeInViewport();
  const box = await cta.boundingBox();
  if (!box) throw new Error("the button has no box");
  // Pinned to the bottom, and left of the launcher's 48 px square at 20 px.
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 20 - 48);
  const launcher = page.getByRole("button", { name: "Abrir asistente" });
  if ((await launcher.count()) > 0) {
    const fab = await launcher.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(fab?.x ?? 390);
  }
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

  await cta.click();
  await expect(page.getByRole("dialog", { name: "Registrar operación" })).toBeVisible();
});

test("a registration lands on its row, marked, and «Añadir otra» keeps its day (#1829)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Otra E2E");

  // From far down the ficha: the strip's button, a backdated buy.
  await scrollPastTheBar(page);
  await strip(page)
    .getByRole("button", { exact: true, name: "Registrar operación" })
    .click();
  const form = page
    .getByRole("dialog", { name: "Registrar operación" })
    .getByRole("form", { name: "Registrar operación" });
  await form.getByLabel("Fecha de ejecución").fill("2026-09-12");
  await form.getByLabel("Unidades").fill("5");
  await form.getByLabel("Precio por unidad en EUR").fill("106,65");
  await form.getByRole("button", { name: "Registrar operación" }).click();

  // The panel closes and the ficha lands on the ledger, the notice in view.
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Secciones de la ficha" })
      .getByRole("link", { name: /Operaciones/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("status")).toHaveText("Guardado.");
  await expect(page.getByRole("status")).toBeInViewport();

  // The new row — only it — is pointed at, in words as well as in tint.
  const fresh = page.locator("#operaciones tr[data-fresh]");
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toContainText("12/09/2026");
  await expect(fresh).toContainText("nueva");
  await expect(fresh).toBeInViewport();

  // «Añadir otra» is where focus went, and it re-opens the form on that day.
  const again = page.getByRole("button", { name: "Añadir otra" });
  await expect(again).toBeFocused();
  await again.click();
  const reopened = page.getByRole("dialog", { name: "Registrar operación" });
  await expect(reopened.getByLabel("Fecha de ejecución")).toHaveValue("2026-09-12");
  await expect(reopened.locator('select[name="currency"]')).toHaveValue("EUR");
  await expect(reopened.getByLabel("Unidades")).toHaveValue("");

  // Opened from the bar instead, it starts on its own defaults again.
  await page.keyboard.press("Escape");
  const fromBar = await openFichaAction(page, "Registrar operación");
  await expect(fromBar.getByLabel("Fecha de ejecución")).not.toHaveValue("2026-09-12");
});

test("«Añadir cobro» asks which cobro first, shows that form only, and «Añadir otro» keeps its day (#1829)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Cobro Suelto E2E");
  // A fund that never paid anything keeps the action in «Más».
  await expect(
    bar(page).getByRole("button", { exact: true, name: "Añadir cobro" }),
  ).toHaveCount(0);

  const panel = await openFichaAction(page, "Añadir cobro");
  await expect(panel.getByRole("radio", { name: "Un cobro suelto" })).toBeChecked();
  await expect(panel.getByRole("button", { name: "Añadir cobro" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Añadir recurrente" })).toBeHidden();

  await panel.getByText("Uno que se repite").click();
  await expect(panel.getByRole("button", { name: "Añadir recurrente" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Añadir cobro" })).toBeHidden();
  await panel.getByText("Un cobro suelto").click();

  await panel.getByLabel("Importe del cobro", { exact: true }).fill("12,50");
  await panel.locator('input[name="dateISO"]').fill("2026-03-15");
  await panel.getByRole("button", { name: "Añadir cobro" }).click();

  // Landed on «Cobros», its month open and the new row marked.
  await expect(page).toHaveURL(/pesta%C3%B1a=cobros.*ok=payout_saved/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const fresh = page.locator(".cobrosRow[data-fresh]");
  await expect(fresh).toContainText("15 mar 2026");
  await expect(fresh).toContainText("nuevo");
  // It has paid now: «Añadir cobro» is at hand.
  await expect(
    bar(page).getByRole("button", { exact: true, name: "Añadir cobro" }),
  ).toBeVisible();

  const again = page.getByRole("button", { name: "Añadir otro" });
  await expect(again).toBeFocused();
  await again.click();
  const reopened = page.getByRole("dialog", { name: "Añadir cobro" });
  await expect(reopened.getByRole("radio", { name: "Un cobro suelto" })).toBeChecked();
  await expect(reopened.locator('input[name="dateISO"]')).toHaveValue("2026-03-15");
  await expect(reopened.getByLabel("Importe del cobro", { exact: true })).toHaveValue("");
});
