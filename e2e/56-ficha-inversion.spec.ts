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
 * And the header is honest about its price (#1828): it says where the price comes
 * from and of when, and the warning about a missing symbol sits beside it with its
 * two ways out — fix it in «Datos del activo», or say it is quoted by hand.
 */

import {
  addHolding,
  expect,
  holdingRow,
  openFichaAction,
  openFichaTab,
  test,
  waitForHydration,
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
    "Este activo no ha pagado nada todavía.",
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

test("the price says where it comes from, and «Indicar símbolo» lands on the field (#1828)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Origen E2E");
  const state = page.getByRole("region", { name: "Estado del activo" });

  // The alta's hand-set price, dated the day it was set — today.
  const [year, month, day] = new Date().toISOString().slice(0, 10).split("-");
  await expect(state).toContainText("10 a 100 €");
  await expect(state).toContainText(`precio a mano · ${day}/${month}/${year}`);

  // No symbol: the warning sits beside the price, and the band does not repeat it.
  await expect(state).toContainText("Sin cotización automática.");
  await expect(page.getByRole("alert", { name: "Avisos" })).toHaveCount(0);

  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const fix = state.getByRole("link", { name: "Indicar símbolo" });
  await waitForHydration(fix);
  await fix.click();

  // «Datos del activo», in place, with the cursor on the symbol field (§8).
  await expect(page).toHaveURL(/pesta%C3%B1a=datos/);
  await expect(page.getByRole("textbox", { name: "Símbolo de precio" })).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("«Cotiza a mano» is today's «Es intencional»: the price stops asking for a symbol", async ({
  page,
}) => {
  const ficha = await fundWithBuy(page, "Fondo A Mano E2E");
  const state = page.getByRole("region", { name: "Estado del activo" });

  await state.getByRole("button", { name: "Cotiza a mano" }).click();
  await expect(page).toHaveURL(/ok=warning_acknowledged/);

  await page.goto(ficha);
  await expect(state).toContainText("precio a mano");
  await expect(state).not.toContainText("Sin cotización automática");
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

// ── #1830: the polish of the tabs ─────────────────────────────────────────────

test("a fund with no cobros says so in one line, and its link opens «Añadir cobro» without a reload", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Sin Cobros E2E");
  await openFichaTab(page, "Cobros");
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });

  const record = page.getByRole("region", { name: "Cobros" });
  await expect(record).toContainText("Este activo no ha pagado nada todavía.");
  // No block of zeros: no renta-pasiva strip over an empty year.
  await expect(record).not.toContainText("Renta pasiva");

  const add = record.getByRole("link", { name: "Añadir un cobro" });
  await add.click();
  await expect(page.getByRole("dialog", { name: "Añadir cobro" })).toBeVisible();
  await expect(page).toHaveURL(/pesta%C3%B1a=cobros.*accion=cobro/);

  // Closed, focus goes back to the link that opened it (§8) — still no reload.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("Rentabilidad faces your money (TIR) with the fund (TWR), and each absence says why", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Rentabilidad E2E");
  await openFichaTab(page, "Rentabilidad");

  const money = page.getByRole("region", { name: "Tu dinero TIR" });
  const fund = page.getByRole("region", { name: "El fondo TWR" });
  await expect(money).toBeVisible();
  await expect(fund).toBeVisible();
  // Side by side on a desktop, the owner first.
  const [left, right] = [await money.boundingBox(), await fund.boundingBox()];
  expect(right?.x ?? 0).toBeGreaterThan((left?.x ?? 0) + (left?.width ?? 0) - 1);
  expect(right?.y).toBe(left?.y);

  // Bought today, with no monthly close yet: neither measure exists, and each
  // side says why instead of printing a bare dash.
  await expect(money).toContainText("Sin TIR: todos los movimientos son del mismo día.");
  await expect(fund).toContainText(
    "Sin TWR: hacen falta al menos dos cierres mensuales.",
  );
  await expect(money).toContainText("Ganancia total");
});

test("«Datos del activo» splits identity from price: no field spans the ficha on a desktop", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Datos E2E");
  await openFichaTab(page, "Datos del activo");

  const datos = await page.locator(".fichaDatos").boundingBox();
  const name = await page.getByLabel("Nombre del activo").boundingBox();
  const symbol = await page.getByLabel("Símbolo de precio").boundingBox();
  expect(name?.width ?? 0).toBeLessThan((datos?.width ?? 0) * 0.6);
  // Price beside identity, not under it.
  expect(symbol?.x ?? 0).toBeGreaterThan((name?.x ?? 0) + (name?.width ?? 0));

  // At 390 px the two columns are one again, and nothing scrolls sideways.
  await page.setViewportSize({ height: 844, width: 390 });
  const narrowName = await page.getByLabel("Nombre del activo").boundingBox();
  const narrowSymbol = await page.getByLabel("Símbolo de precio").boundingBox();
  expect(narrowSymbol?.x).toBe(narrowName?.x);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
});
