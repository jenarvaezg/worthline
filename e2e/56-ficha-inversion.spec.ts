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
 * And the ledger (#1827): compact rows with their importe, the 10 latest and the rest
 * unfolded in place without a reload, and at 390 px two lines per apunte that never
 * scroll sideways.
 *
 * And the header is honest about its price (#1828): it says where the price comes
 * from and of when, and the warning about a missing symbol sits beside it with its
 * two ways out — fix it in «Datos del activo», or say it is quoted by hand.
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

  // It stays on the ficha (#1731 review): its own notice, beside the price that
  // no longer asks for a symbol — not a trip to the board.
  await expect(page).toHaveURL(new RegExp(`${ficha}\\?ok=warning_acknowledged$`));
  await expect(page.getByRole("status")).toHaveText("Aviso marcado como intencional.");
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
  // The record rounds its strip to the euro, so the count is the exact signal. It
  // ends the window's line, or comes before the coverage when the run's FIRE
  // settings declare a spending (journey 37 does): the suite shares one database.
  await expect(page.getByRole("region", { name: "Cobros" })).toContainText(
    /· 1 cobro(?: ·|\.)/,
  );
});

test("a refused cobro comes back to its form in the panel, with what was typed (#1731 review)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Cobro Rechazado E2E");

  const panel = await openFichaAction(page, "Añadir cobro");
  await panel.getByLabel("Importe del cobro", { exact: true }).fill("0");
  await panel.getByLabel("Nota del cobro").fill("Dividendo");
  await panel.getByRole("button", { name: "Añadir cobro" }).click();

  // The panel is where the refusal is read, over the form that produced it: the
  // refusal's own form id opens it, over the Cobros tab.
  await expect(page).toHaveURL(/pesta%C3%B1a=cobros.*form=payoutOneOff/);
  const reopened = page.getByRole("dialog", { name: "Añadir cobro" });
  await expect(reopened.getByRole("alert")).toHaveText(
    "Introduce un importe mayor que cero.",
  );
  await expect(reopened.getByRole("radio", { name: "Un cobro suelto" })).toBeChecked();
  await expect(reopened.getByLabel("Importe del cobro", { exact: true })).toHaveValue(
    "0",
  );
  await expect(reopened.getByLabel("Nota del cobro")).toHaveValue("Dividendo");
});

test("with JavaScript off, a refused recurring cobro reopens on «Uno que se repite» (#1731 review)", async ({
  browser,
  page,
}) => {
  const ficha = await fundWithBuy(page, "Fondo Recurrente Sin JS E2E");

  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const bare = await context.newPage();
    await bare.goto(`${ficha}?accion=cobro`);
    const panel = bare.getByRole("dialog", { name: "Añadir cobro" });
    await panel.getByText("Uno que se repite").click();
    // A concept and nothing else: the door asks where the figure comes from.
    await panel.getByLabel("Concepto del cobro recurrente").fill("Cupón");
    await panel.getByRole("button", { name: "Añadir recurrente" }).click();

    await expect(bare).toHaveURL(/form=payoutRecurring/);
    const reopened = bare.getByRole("dialog", { name: "Añadir cobro" });
    await expect(
      reopened.getByRole("radio", { name: "Uno que se repite" }),
    ).toBeChecked();
    await expect(reopened.getByRole("alert")).toBeVisible();
    await expect(reopened.getByLabel("Concepto del cobro recurrente")).toHaveValue(
      "Cupón",
    );
  } finally {
    await context.close();
  }
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

  // The ledger reads in two lines per apunte, with nothing to scroll sideways
  // (#1827): «dd/mm/aaaa · Compra» with the importe at the right, the sum under it.
  const ledger = page.getByRole("region", { name: "Operaciones de la inversión" });
  const row = ledger.locator("tbody tr").first();
  await expect(row.locator(".opsCalc")).toHaveText(/^10 × 100\s€$/);
  expect(
    await ledger.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(0);
  const date = await row.locator(".opsDate").boundingBox();
  const amount = await row.locator(".opsAmount").boundingBox();
  const sum = await row.locator(".opsCalc").boundingBox();
  expect(Math.abs((date?.y ?? 0) - (amount?.y ?? 0))).toBeLessThan(6);
  expect(sum?.y ?? 0).toBeGreaterThanOrEqual((date?.y ?? 0) + (date?.height ?? 0) - 1);
  expect((amount?.x ?? 0) + (amount?.width ?? 0)).toBeLessThanOrEqual(390);

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

  // Another form's success with the same `ok` is not the panel's: «Lo básico»
  // lands on `?pestaña=datos&ok=saved` and its notice offers nothing.
  await page.keyboard.press("Escape");
  await openFichaTab(page, "Datos del activo");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(/editar\?pesta%C3%B1a=datos&ok=saved$/);
  await expect(page.getByRole("status")).toHaveText("Guardado.");
  await expect(page.getByRole("button", { name: "Añadir otra" })).toHaveCount(0);
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

test("a recurring cobro just declared is pointed at in the declared list (#1731 review)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Cupón E2E");

  const panel = await openFichaAction(page, "Añadir cobro");
  await panel.getByText("Uno que se repite").click();
  await panel.getByLabel("Concepto del cobro recurrente").fill("Cupón semestral");
  await panel.getByLabel("Importe del cobro recurrente").fill("40");
  // It starts next year: no occurrence in the grid yet, so the grid has nothing
  // new to point at — the declaration is the row that is new.
  await panel
    .locator('input[name="startISO"]')
    .fill(`${new Date().getFullYear() + 1}-01-15`);
  // The radio is drawn by its label (the input is visually hidden): click the words.
  await panel
    .getByRole("radiogroup", { name: "De dónde sale la cifra" })
    .getByText("Estimación mía")
    .click();
  await panel.getByLabel("Fecha de corte de la cifra").fill("2026-01-01");
  await panel.getByRole("button", { name: "Añadir recurrente" }).click();

  await expect(page).toHaveURL(/pesta%C3%B1a=cobros.*ok=payout_schedule_saved/);
  const fresh = page.locator(".cobrosSchedule[data-fresh]");
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toContainText("Cupón semestral");
  await expect(fresh).toContainText("nuevo");
});

test("when the notice and the new row do not fit together, «Añadir otro» stays on screen with the focus (#1731 review)", async ({
  page,
}) => {
  // A short screen: the Cobros tab, its grid and the open month are taller than
  // what is left under the notice. Focus never lands on something off screen.
  const ficha = await fundWithBuy(page, "Fondo Pantalla Corta E2E");
  await page.setViewportSize({ height: 520, width: 1280 });
  await page.goto(ficha);

  const panel = await openFichaAction(page, "Añadir cobro");
  await panel.getByLabel("Importe del cobro", { exact: true }).fill("12,50");
  await panel.getByRole("button", { name: "Añadir cobro" }).click();
  await expect(page).toHaveURL(/ok=payout_saved/);

  const again = page.getByRole("button", { name: "Añadir otro" });
  await expect(again).toBeFocused();
  await expect(again).toBeInViewport();
  await expect(page.locator(".cobrosRow[data-fresh]")).toContainText("nuevo");
});

test("the ledger shows the 10 latest with their importe and unfolds the rest without a reload (#1827)", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Libro E2E");

  // Eleven older buys in one go, through the ficha's own «Cargar movimientos».
  const statement = await openFichaAction(page, "Cargar movimientos");
  const csv = [
    "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
    ...Array.from(
      { length: 11 },
      (_, index) =>
        `2026-01-${String(index + 1).padStart(2, "0")};Fondo;IE00B4L5Y983;Compra;2;210;1,50;Fondo Libro E2E`,
    ),
  ].join("\n");
  await statement.locator('input[name="file"]').setInputFiles({
    buffer: Buffer.from(csv),
    mimeType: "text/csv",
    name: "movimientos.csv",
  });
  await statement.getByRole("button", { name: "Ver cambios" }).click();
  await expect(statement.getByText("11 movimientos nuevos")).toBeVisible();
  await statement.getByRole("button", { name: "Confirmar y cargar" }).click();
  await expect(page).toHaveURL(/ok=statement_loaded/);

  const ledger = page.getByRole("region", { name: "Operaciones de la inversión" });
  const rows = ledger.locator("tbody tr");
  await expect(rows).toHaveCount(10);

  // The importe is the domain's: 2 × 105 € + 1,50 € of fees.
  const older = rows.filter({ hasText: "11/01/2026" });
  await expect(older.locator(".opsAmount")).toHaveText(/^211,50\s€$/);
  // «Eliminar» waits inside the row's «⋯».
  await expect(older.getByText("Eliminar")).toBeHidden();
  await older.getByLabel("Acciones de la operación del 11/01/2026").click();
  await expect(older.getByText("Eliminar")).toBeVisible();
  await older.getByLabel("Acciones de la operación del 11/01/2026").click();

  // Ten rows of about 35 px fit a desktop screen.
  const firstBox = await rows.first().boundingBox();
  expect(firstBox?.height ?? 0).toBeLessThanOrEqual(40);

  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const more = ledger.getByRole("button", { name: "Ver las 12 operaciones" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(rows).toHaveCount(12);
  // The unfolded ledger is in the URL (interaction-patterns §3): shareable, and what a
  // terminal lands back on.
  await expect(page).toHaveURL(/libro=todas/);
  await expect(rows.last()).toContainText("01/01/2026");
  await expect(
    ledger.getByRole("button", { name: "Ver solo las 10 últimas" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  // Deleting a row past the tenth keeps the ledger where the person left it:
  // unfolded, so the next one is still in reach.
  const oldest = rows.filter({ hasText: "01/01/2026" });
  await oldest.getByLabel("Acciones de la operación del 01/01/2026").click();
  await oldest.locator("details.confirmDelete summary").click();
  await oldest.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toContainText("Operación eliminada");
  await expect(rows).toHaveCount(11);
  await expect(
    ledger.getByRole("button", { name: "Ver solo las 10 últimas" }),
  ).toHaveAttribute("aria-expanded", "true");
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

// ── #1731 review: the rarer actions, end to end ────────────────────────────────

/** The ISO day `days` before today. */
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** The ficha's tab on show, by its visible name. */
const activeTab = (page: import("@playwright/test").Page, name: RegExp) =>
  page
    .getByRole("navigation", { name: "Secciones de la ficha" })
    .getByRole("link", { name });

test("«Traer de otra entidad» records the entry and lands on its row in the ledger", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Entrada E2E");

  const panel = await openFichaAction(page, "Traer de otra entidad");
  const form = panel.getByRole("form", { name: "Registrar entrada desde otra entidad" });
  await form.getByLabel("¿Cuánto entró? (€)").fill("500");
  await form.getByLabel("Valor liquidativo de ese día (€)").fill("100");
  await form.getByRole("button", { name: "Registrar entrada" }).click();

  await expect(page).toHaveURL(/ok=external_entry_recorded/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(
    "Entrada por traspaso desde otra entidad registrada.",
  );
  await expect(activeTab(page, /Operaciones/)).toHaveAttribute("aria-current", "true");
  const fresh = page.locator("#operaciones tr[data-fresh]");
  await expect(fresh).toContainText("Traspaso (entrada)");
  await expect(fresh).toContainText("desde otra entidad");
  // 10 bought + 5 that came in.
  await expect(page.getByRole("region", { name: "Estado del activo" })).toContainText(
    "15 a 100 €",
  );
});

test("«Corregir precio de un día» previews the snapshots it touches and confirms on Rentabilidad", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Corrección E2E");

  const panel = await openFichaAction(page, "Corregir precio de un día");
  await panel.getByLabel("Precio por unidad (EUR)").fill("105");
  await panel.getByRole("button", { name: "Ver cambios" }).click();
  await expect(panel.getByText(/Esta corrección aplicará/)).toBeVisible();
  await panel.getByRole("button", { name: "Confirmar corrección" }).click();

  await expect(page).toHaveURL(/ok=snapshot_price_corrected/);
  await expect(page.getByRole("status")).toContainText("corregido.");
  await expect(activeTab(page, /Rentabilidad/)).toHaveAttribute("aria-current", "true");
});

test("«Rellenar histórico de precios» freezes the provider's past prices on the days valued at cost", async ({
  page,
}) => {
  // CoinGecko is the provider the harness fakes (`E2E_FAKE_PORT`): a flat 40.000 €
  // a day over the last 75 days. No symbol at the alta, so nothing prices it today
  // and the history a backdated buy rebuilds is valued at cost.
  await addHolding(page, { instrument: "crypto", name: "Cripto Histórico E2E" });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");
  await page.goto("/patrimonio");
  await holdingRow(page, "Cripto Histórico E2E")
    .getByRole("link", { name: "Cripto Histórico E2E" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);

  const buy = (await openFichaAction(page, "Registrar operación")).getByRole("form", {
    name: "Registrar operación",
  });
  await buy.getByLabel("Fecha de ejecución").fill(daysAgo(40));
  await buy.getByLabel("Unidades").fill("0,1");
  await buy.getByLabel("Precio por unidad en EUR").fill("30000");
  await buy.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);

  // Now the symbol: the provider can say what those days were worth. The buy left
  // `?ok=saved` in the URL already, so the save's own terminal is the signal.
  await openFichaTab(page, "Datos del activo");
  await page.getByLabel("Símbolo de precio").fill("bitcoin");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(/editar\?pesta%C3%B1a=datos&ok=saved$/);

  const panel = await openFichaAction(page, "Rellenar histórico de precios");
  await panel.getByRole("button", { name: "Ver cambios" }).click();
  await expect(panel.getByText("Este relleno aplicará:")).toBeVisible();
  await panel.getByRole("button", { name: "Confirmar y rellenar" }).click();

  await expect(page).toHaveURL(/ok=price_backfill_done/);
  await expect(page.getByRole("status")).toHaveText(
    "Histórico de precios rellenado desde coingecko.",
  );
  await expect(activeTab(page, /Rentabilidad/)).toHaveAttribute("aria-current", "true");
});

test("a warning's «Ver operaciones» switches to the ledger in place, without a reload", async ({
  page,
}) => {
  await fundWithBuy(page, "Fondo Sobreventa E2E");

  // A sale past the units held, confirmed: the band warns and links to the ledger.
  const form = (await openFichaAction(page, "Registrar operación")).getByRole("form", {
    name: "Registrar operación",
  });
  await form.getByLabel("Tipo").selectOption("sell");
  await form.getByLabel("Unidades").fill("15");
  await form.getByLabel("Precio por unidad en EUR").fill("100");
  await form.getByRole("button", { name: "Registrar operación" }).click();
  await form.getByLabel("Confirmo la venta").check();
  await form.getByRole("button", { name: "Registrar operación" }).click();
  // The buy left `?ok=saved` in the URL: the settled signal is the band's warning.
  const band = page.getByRole("alert", { name: "Avisos" });
  await expect(band).toBeVisible();

  await openFichaTab(page, "Datos del activo");
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const fix = band.getByRole("link", { name: "Ver operaciones" }).first();
  await waitForHydration(fix);
  await fix.click();

  await expect(activeTab(page, /Operaciones/)).toHaveAttribute("aria-current", "true");
  await expect(page).not.toHaveURL(/pesta%C3%B1a=datos/);
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);
});

test("the header's gain is the board row's gain, to the cent and the tenth of a percent (#1828)", async ({
  page,
}) => {
  const ficha = await fundWithBuy(page, "Fondo Ganancia E2E");

  // A price above what it cost, so the gain is not a trivial zero.
  await openFichaTab(page, "Datos del activo");
  await page.getByLabel(/Precio manual por unidad/).fill("123");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  // The buy left `?ok=saved` already: the save's own terminal is the signal.
  await expect(page).toHaveURL(/editar\?pesta%C3%B1a=datos&ok=saved$/);

  await page.goto(ficha);
  const header = page
    .getByRole("region", { name: "Estado del activo" })
    .locator(".fichaFigures div", { hasText: "Ganancia total" })
    .locator(".fichaFigure");
  await expect(header).toHaveText(/· \+23,0\s%$/);
  const headerGain = (await header.innerText()).trim();

  await page.goto("/patrimonio");
  const row = holdingRow(page, "Fondo Ganancia E2E").locator(".balanceRowReturns");
  // The row prints «▲ 230 € · +23,0 %» plus its tooltip: the figure is the same.
  await expect(row).toContainText(headerGain);
});
