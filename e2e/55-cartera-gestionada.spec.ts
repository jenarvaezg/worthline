/**
 * Journey 55: una cartera gestionada, de su alta a su rentabilidad (#1707, PRD
 * #1399, ADR 0085).
 *
 * La feature se cerró con seis rebanadas (#1547–#1552) y cero cobertura e2e, y es
 * de las que más invariantes finas guarda: el careo excluye el efectivo, la
 * rentabilidad cancela los traspasos por `transferId`, el agregado se archiva sin
 * pasar por la ceremonia de la Papelera. Todas vivían solo en tests de unidad —
 * es decir, ninguna estaba medida contra el navegador que las usa.
 *
 * Los cuatro trayectos del ticket, en el orden en que un dueño los recorre, y
 * encadenados a propósito: cada uno deja el libro en el estado que el siguiente
 * necesita, igual que la sustitución progresiva del #1551 ocurre en la vida real.
 * `serial` para que un fallo temprano no repita el mismo síntoma cuatro veces.
 *
 * La aritmética está elegida para que ninguna cifra dependa de un redondeo:
 *
 *   saldo declarado           1.000 €
 *   Fondo Alfa   5 × 100 €  =   500 €   (comprado a 80 €/u  → 400 € invertidos)
 *   Fondo Beta   5 × 100 €  =   500 €   (comprado a 100 €/u → 500 € invertidos)
 *   agregado «(sin detallar)» 1.000 € → 500 € → retirado
 *   invertido 900 €, valor 1.000 €, plusvalía 100 € → +11,1 %
 *
 * y el traspaso interno (200 €, 2 participaciones a VL 100 en ambos lados) deja
 * Alfa en 300 € y Beta en 700 €: la cartera sigue valiendo 1.000 € y sigue
 * habiendo costado 900 €. Ahí está el filo del #1552 — sin cancelar el par, el
 * denominador subiría a 1.100 € y la cartera leería como si la hubieran fondeado
 * dos veces.
 *
 * Las aserciones dicen «1000 €» y no «1.000 €» a propósito: el es-ES no agrupa
 * los millares de cuatro dígitos (`minimumGroupingDigits: 2`), así que eso es
 * literalmente lo que `formatMoneyMinor` imprime. Al teclear sí se escribe
 * «1.000,00» — con la coma, que es lo que desambigua el punto de millar.
 */

import {
  addHolding,
  expect,
  holdingRow,
  openAdvancedSettings,
  test,
  waitForHydration,
} from "./fixtures";

const CARTERA = "Cartera Gestionada E2E";
const PROVIDER = "MyInvestor E2E";
const AGGREGATE = `${CARTERA} (sin detallar)`;
const CASH = `Efectivo ${CARTERA}`;
const ALFA = "Fondo Alfa E2E";
const BETA = "Fondo Beta E2E";

/** La ficha de la cartera, capturada en el alta y reusada por los cuatro pasos. */
let fichaUrl = "";

test.describe.configure({ mode: "serial" });

/** Una sección de la ficha, por el nombre accesible que la etiqueta. */
function region(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("region", { name });
}

/** Una fila de la tabla de rentabilidad, por su encabezado de fila. */
function returnRow(page: import("@playwright/test").Page, label: string) {
  return region(page, "Rentabilidad").locator("tr", { hasText: label });
}

/**
 * El patrimonio neto del tablero en céntimos.
 *
 * Se parsea en vez de compararse como cadena porque lo que estos trayectos
 * afirman es una DIFERENCIA («el alta suma exactamente el saldo declarado»), y
 * una comparación de textos solo sabe decir «igual» o «distinto».
 */
async function readNetWorthMinor(page: import("@playwright/test").Page): Promise<number> {
  const net = page.locator(".balanceReconNet .balanceReconValue").first();
  await expect(net).toBeVisible();
  const printed = (await net.textContent()) ?? "";
  // es-ES sin decimales: «1.234 €», y el menos puede ser el U+2212 tipográfico.
  const digits = printed.replace(/\D/g, "");
  const negative = /[−-]/.test(printed);
  return (negative ? -1 : 1) * Number(digits) * 100;
}

/** Lo mismo, yendo primero al tablero. */
async function netWorthMinor(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/patrimonio");
  return readNetWorthMinor(page);
}

/** Da de alta un fondo de precio manual y le registra su compra. */
async function addFundWithBuy(
  page: import("@playwright/test").Page,
  input: { name: string; price: string; units: string; unitPrice: string },
) {
  await addHolding(page, { instrument: "fund", name: input.name, price: input.price });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await page.goto("/patrimonio");
  const row = holdingRow(page, input.name);
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: input.name }).first().click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);

  const form = page.getByRole("form", { name: "Registrar operación" });
  await form.getByLabel("Unidades").fill(input.units);
  await form.getByLabel("Precio por unidad en EUR").fill(input.unitPrice);
  await form.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
}

/**
 * Abre la ficha de un fondo MIEMBRO desde la composición de la cartera.
 *
 * Un miembro ya no es una fila suelta del tablero — vive dentro del bloque
 * (#1548) —, así que la puerta a su ficha es el enlace de la composición: el
 * mismo camino que recorre el dueño cuando quiere mirar uno de sus fondos.
 */
async function openMemberFicha(page: import("@playwright/test").Page, name: string) {
  await page.goto(fichaUrl);
  await region(page, "Composición").getByRole("link", { exact: true, name }).click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);
}

/** Marca fondos como miembros de la cartera y guarda. */
async function saveMembers(
  page: import("@playwright/test").Page,
  names: readonly string[],
) {
  await page.goto(fichaUrl);
  const miembros = region(page, "Miembros");
  await expect(miembros).toBeVisible();
  for (const name of names) {
    // El input nativo del chip va oculto por el canon (§4: `opacity: 0`), así que
    // se marca por su etiqueta — el mismo gesto que hace el dedo.
    const chip = miembros.locator(".chipChoice label", { hasText: name });
    await expect(chip.locator("input")).not.toBeChecked();
    await chip.click();
    await expect(chip.locator("input")).toBeChecked();
  }
  await miembros.getByRole("button", { name: "Guardar cartera" }).click();
  await expect(page).toHaveURL(/ok=cartera_guardada/);
}

test("alta «solo saldo»: grupo, testigo y agregado se escriben juntos, y el tablero lo lee como un sumando", async ({
  page,
}) => {
  const netBefore = await netWorthMinor(page);

  // 1. El alta que el #1551 abrió: un nombre y el número que se lee en la app del
  //    gestor. Ni participaciones ni VL ni fecha de compra — nada que el dueño no
  //    haya dicho.
  await page.goto("/patrimonio/carteras");
  const createForm = page.locator("#carterasCreateForm");
  await expect(createForm).toBeVisible();
  await createForm.locator('input[name="name"]').fill(CARTERA);
  await createForm.locator('input[name="provider"]').fill(PROVIDER);
  await createForm.locator('input[name="declaredValue"]').fill("1.000,00");
  await createForm.getByRole("button", { name: "Crear cartera" }).click();

  // 2. El alta aterriza en la ficha de la cartera recién creada (#1547).
  await expect(page).toHaveURL(/\/patrimonio\/carteras\/wl_prt_[^/?]+\?ok=/);
  fichaUrl = new URL(page.url()).pathname;
  await expect(page.locator(".successBand")).toContainText("sin detallar la composición");

  // 3. Las TRES escrituras del #1600 llegaron juntas: el grupo, su agregado y el
  //    testigo. Una sola de las tres ausente dejaría una cartera que el dueño cree
  //    que lleva sus 1.000 €.
  await expect(
    region(page, "Valor de la cartera").locator(".headline strong"),
  ).toHaveText("1000 €");
  const composicion = region(page, "Composición");
  await expect(composicion.locator("tr", { hasText: AGGREGATE })).toContainText(
    "sin detallar",
  );
  await expect(composicion.locator("tr", { hasText: AGGREGATE })).toContainText("1000 €");
  await expect(composicion.locator("tr", { hasText: CASH })).toContainText("efectivo");
  await expect(composicion.locator("tr", { hasText: CASH })).toContainText("0 €");

  // El careo del #1550 nace cuadrado: el testigo es el mismo importe con el que
  // nació el agregado, y el efectivo (0 €) queda declaradamente fuera.
  const testigo = region(page, "Saldo declarado");
  await expect(testigo.locator("tr", { hasText: "Saldo que declaraste" })).toContainText(
    "1000 €",
  );
  await expect(testigo.locator("tr", { hasText: "Deriva" })).toContainText("+0,0 %");
  await expect(testigo.locator(".warningBand")).toHaveCount(0);
  await expect(testigo).toContainText("queda fuera del careo");

  // 4. Sin fondos con operaciones no hay rentabilidad que derivar, y la ficha lo
  //    dice en vez de imprimir un 0 % fabricado (ADR 0040).
  await expect(region(page, "Rentabilidad")).toContainText(
    "Todavía no hay fondos con operaciones",
  );

  // 5. El tablero: el bloque es UN sumando (#1548). El patrimonio sube exactamente
  //    el saldo declarado, ni un céntimo más — el agregado es la cartera entera.
  expect(await netWorthMinor(page)).toBe(netBefore + 100_000);

  const bloque = holdingRow(page, CARTERA);
  await expect(bloque).toBeVisible();
  await expect(bloque.locator(".balanceGroupChip")).toHaveText("cartera");
  await expect(bloque).toContainText(PROVIDER);
  await expect(bloque).toContainText("2 posiciones");
  await expect(bloque.locator(".balanceRowAmount")).toHaveText("1000 €");

  // Y sus miembros NO son filas sueltas del tablero: si lo fueran, el mismo dinero
  // aparecería dos veces en la columna que suma.
  await expect(holdingRow(page, AGGREGATE)).toHaveCount(0);
  await expect(holdingRow(page, CASH)).toHaveCount(0);

  // Desplegado enseña su composición sin dejar de ser un sumando: Σ filas = bruto
  // se sostiene en los dos estados, que es el punto entero del bloque. El pliegue
  // es cliente (#1548), así que se espera a que React sea dueño del botón — un
  // clic anterior a la hidratación no despliega nada y el fallo diría otra cosa.
  const caret = bloque.getByRole("button", { name: `Desplegar ${CARTERA}` });
  await waitForHydration(caret);
  await caret.click();
  const miembros = page.locator(".balanceGroupMembers");
  await expect(miembros).toContainText(AGGREGATE);
  await expect(miembros).toContainText(CASH);
  // Sin volver a navegar: el pliegue se refleja en la URL con `pushState`, así que
  // un `goto` lo desharía y la comparación no diría nada.
  expect(await readNetWorthMinor(page)).toBe(netBefore + 100_000);
});

test("detallar la cartera: el agregado sugiere «declarado − Σ detallado» y baja al añadir un fondo", async ({
  page,
}) => {
  const pendiente = () => region(page, "Pendiente de detallar");

  // 1. Sin nada detallado, toda la cartera está en el agregado: la sugerencia es
  //    el saldo declarado entero.
  await page.goto(fichaUrl);
  await expect(pendiente()).toContainText("Toda la cartera está aquí, sin detallar");
  await expect(pendiente().locator('input[name="remainderValue"]')).toHaveValue(
    "1000,00",
  );

  // 2. Entra el primer fondo real. Mientras el agregado siga representando lo que
  //    ya está detallado aparte, el libro cuenta el mismo dinero dos veces — y el
  //    careo lo dice en voz alta en vez de callarse (enmienda #1551 del ADR 0085).
  await addFundWithBuy(page, {
    name: ALFA,
    price: "100",
    units: "5",
    unitPrice: "80",
  });
  await saveMembers(page, [ALFA]);
  await expect(page.locator(".successBand")).toContainText("Sigue teniendo una parte");
  await expect(region(page, "Saldo declarado").locator(".warningBand")).toBeVisible();

  // 3. La sugerencia BAJÓ a `declarado − Σ detallado` = 1.000 − 500. Ni el efectivo
  //    de la cartera ni el propio agregado entran en esa resta.
  await expect(
    pendiente().locator("tr", { hasText: "Fondos ya detallados" }),
  ).toContainText("500 €");
  await expect(pendiente()).toContainText("quedan 500 € sin detallar");
  await expect(pendiente().locator('input[name="remainderValue"]')).toHaveValue("500,00");

  // 4. Dejarlo en la cifra sugerida devuelve el libro a su sitio: 500 € detallados
  //    + 500 € sin detallar = el saldo declarado, y el careo vuelve a cuadrar.
  await pendiente().locator('input[name="remainderValue"]').fill("500,00");
  await pendiente().getByRole("button", { name: "Guardar el agregado" }).click();
  await expect(page).toHaveURL(/ok=agregado_ajustado/);

  await expect(
    region(page, "Valor de la cartera").locator(".headline strong"),
  ).toHaveText("1000 €");
  await expect(
    region(page, "Saldo declarado").locator("tr", { hasText: "Deriva" }),
  ).toContainText("+0,0 %");
  await expect(region(page, "Saldo declarado").locator(".warningBand")).toHaveCount(0);
  await expect(pendiente()).toContainText("Nada que ajustar");
});

test("el agregado a cero se archiva sin ceremonia de papelera, y la cartera queda entera", async ({
  page,
}) => {
  const netBefore = await netWorthMinor(page);

  // 1. Entra el segundo fondo: lo detallado ya cubre el saldo declarado, así que
  //    no queda nada que el agregado represente.
  await addFundWithBuy(page, {
    name: BETA,
    price: "100",
    units: "5",
    unitPrice: "100",
  });
  await saveMembers(page, [BETA]);

  const pendiente = region(page, "Pendiente de detallar");
  await expect(pendiente).toContainText("cubren el saldo que declaraste");
  // Con la resta en cero la ficha deja de pedir una cifra: la única salida honesta
  // es retirarlo, no teclear un 0 en un campo que ya sabe la respuesta.
  await expect(pendiente.locator('input[name="remainderValue"]')).toHaveCount(0);

  // 2. Un solo submit lo archiva. El agregado no lleva libro de operaciones, así
  //    que la puerta de la Papelera (#1549) no tiene nada que rechazar: no hay
  //    ceremonia de tres salidas, no hay refusal, no hay dinero que se evapore.
  await pendiente.getByRole("button", { name: "Retirar el agregado" }).click();
  await expect(page).toHaveURL(/ok=agregado_retirado/);
  await expect(page.locator(".successBand")).toContainText("Papelera");

  // 3. La cartera queda enteramente detallada: sin bloque «pendiente», con sus dos
  //    fondos y su caja, y el careo cuadrado contra el mismo saldo declarado.
  await expect(page.getByRole("region", { name: "Pendiente de detallar" })).toHaveCount(
    0,
  );
  await expect(
    region(page, "Valor de la cartera").locator(".headline strong"),
  ).toHaveText("1000 €");
  const composicion = region(page, "Composición");
  await expect(composicion.locator("tr", { hasText: ALFA })).toContainText("500 €");
  await expect(composicion.locator("tr", { hasText: BETA })).toContainText("500 €");
  await expect(composicion.locator("tr", { hasText: AGGREGATE })).toHaveCount(0);
  await expect(
    region(page, "Saldo declarado").locator("tr", { hasText: "Deriva" }),
  ).toContainText("+0,0 %");

  // 4. La sustitución no movió el patrimonio: 1.000 € de agregado salieron y
  //    1.000 € de fondos entraron, y el neto es el mismo antes y después.
  expect(await netWorthMinor(page)).toBe(netBefore);

  // 5. Archivado, no borrado: el agregado está en la Papelera con su importe, por
  //    si el dueño se arrepiente de haber detallado.
  const papelera = page.locator("details.balanceTrash");
  await waitForHydration(papelera);
  if (!(await papelera.evaluate((el: HTMLDetailsElement) => el.open))) {
    await papelera.locator("> summary").click();
  }
  await expect(papelera).toContainText(AGGREGATE);
});

test("careo: un saldo declarado que se aparta más del 2 % levanta la señal en la ficha", async ({
  page,
}) => {
  const testigo = () => region(page, "Saldo declarado");

  // 1. El dueño teclea un saldo que no es el que worthline deriva: 1.200 € contra
  //    los 1.000 € de sus fondos, una deriva del −16,7 %.
  await page.goto(fichaUrl);
  await testigo().locator('input[name="declaredValue"]').fill("1.200,00");
  await testigo().getByRole("button", { name: "Guardar saldo declarado" }).click();
  await expect(page).toHaveURL(/ok=testigo_guardado/);

  // 2. La señal `portfolio_reconciliation` es visible donde se repara: la ficha
  //    imprime la deriva y avisa, sin adoptar el número declarado. El derivado
  //    manda siempre — el testigo solo puede discrepar en voz alta (#1550).
  await expect(
    testigo().locator("tr", { hasText: "Saldo que declaraste" }),
  ).toContainText("1200 €");
  await expect(testigo().locator("tr", { hasText: "Deriva" })).toContainText("−16,7 %");
  const aviso = testigo().locator(".warningBand");
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("más del 2 %");
  await expect(aviso).toContainText("Manda lo que worthline calcula");
  // Y el careo sigue diciendo qué comparó: el efectivo nunca entra (enmienda
  // 23-08 del ADR 0085), o el aviso saltaría cada mes sin que pase nada.
  await expect(aviso).toContainText("no entra en la comparación");

  // El valor derivado no se movió ni un céntimo por haber declarado otra cosa.
  await expect(
    region(page, "Valor de la cartera").locator(".headline strong"),
  ).toHaveText("1000 €");

  // 3. Corregido el testigo, el aviso se retira solo.
  await testigo().locator('input[name="declaredValue"]').fill("1.000,00");
  await testigo().getByRole("button", { name: "Guardar saldo declarado" }).click();
  await expect(page).toHaveURL(/ok=testigo_guardado/);
  await expect(testigo().locator(".warningBand")).toHaveCount(0);
});

test("traspaso interno: la rentabilidad de la cartera no lo cuenta como flujo, y el par queda atado", async ({
  page,
}) => {
  // 1. La rentabilidad de partida: 900 € invertidos (400 en Alfa + 500 en Beta)
  //    para 1.000 € de valor. La caja está en el valor y fuera de la tasa.
  await page.goto(fichaUrl);
  await expect(returnRow(page, "Invertido")).toContainText("900 €");
  await expect(returnRow(page, "Plusvalía")).toContainText("100 €");
  await expect(returnRow(page, "Rentabilidad")).toContainText("+11,1 %");
  await expect(region(page, "Rentabilidad")).toContainText(
    "Los traspasos entre fondos de la cartera se cancelan en su fecha",
  );

  // 2. Un traspaso interno de 200 € entre dos miembros: 2 participaciones salen de
  //    Alfa a VL 100 y 2 entran en Beta al mismo VL.
  await openMemberFicha(page, ALFA);

  const traspaso = page.getByRole("form", { name: "Traspasar a otra inversión" });
  await expect(traspaso).toBeVisible();
  await traspaso
    .locator('select[name="destinationAssetId"]')
    .selectOption({ label: BETA });
  await traspaso.getByLabel("Importe traspasado en EUR").fill("200");
  await traspaso.getByLabel("Participaciones que salieron del origen").fill("2");
  await traspaso.getByLabel("Participaciones que entraron en el destino").fill("2");
  await traspaso.getByRole("button", { name: "Registrar traspaso" }).click();
  await expect(page).toHaveURL(/ok=transfer_recorded/);

  // 3. El par queda ATADO en las operaciones: cada mitad nombra a la otra, así que
  //    la salida no se lee como una venta ni la entrada como una compra (#1481).
  await openAdvancedSettings(page);
  const salida = page.locator(".recentOpsPanel tr", { hasText: "Traspaso (salida)" });
  await expect(salida).toContainText(`a ${BETA}`);

  await openMemberFicha(page, BETA);
  const entrada = page.locator(".recentOpsPanel tr", { hasText: "Traspaso (entrada)" });
  await expect(entrada).toContainText(`desde ${ALFA}`);
  await expect(entrada).toContainText("coste heredado");

  // 4. El filo del #1552: el par se cancela por `transferId`, así que el capital
  //    movido de un fondo a otro NO es capital que la cartera haya recibido. Las
  //    tres cifras son las mismas de antes del traspaso — sin cancelar, el
  //    denominador sería 1.100 € y la cartera leería como fondeada dos veces.
  await page.goto(fichaUrl);
  await expect(returnRow(page, "Invertido")).toContainText("900 €");
  await expect(returnRow(page, "Plusvalía")).toContainText("100 €");
  await expect(returnRow(page, "Rentabilidad")).toContainText("+11,1 %");

  // Y la composición sí se movió, porque el dinero cambió de fondo: 300 € y 700 €
  // que siguen sumando los mismos 1.000 €.
  const composicion = region(page, "Composición");
  await expect(composicion.locator("tr", { hasText: ALFA })).toContainText("300 €");
  await expect(composicion.locator("tr", { hasText: BETA })).toContainText("700 €");
  await expect(
    region(page, "Valor de la cartera").locator(".headline strong"),
  ).toHaveText("1000 €");
  await expect(
    region(page, "Saldo declarado").locator("tr", { hasText: "Deriva" }),
  ).toContainText("+0,0 %");
});
