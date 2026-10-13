/**
 * Journey 57: el selector de activos de un objetivo con un catálogo largo (#1837).
 *
 * Pasadas las doce opciones, el selector deja de ser un muro de chips y pasa a ser
 * un libro con buscador y cesta. Lo que los tests de unidad no pueden ver es el
 * contrato con el FORMULARIO, y es justo lo que se rompería sin hacer ruido:
 *
 *   - Enter en el buscador añade la fila señalada y NUNCA envía el formulario
 *     (un Enter en un campo de texto envía por defecto).
 *   - Las casillas del libro son lo único que se envía: una fila que el buscador
 *     esconde sigue montada y su casilla sigue viajando en el `FormData`.
 *
 * El catálogo se siembra directo en la BD de la corrida, por la misma costura que
 * usa el global setup: catorce fondos de un mismo peldaño bastan para pasar de doce.
 */
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";

import { expect, test, waitForHydration } from "./fixtures";

const PREFIX = "Libro E2E";
const GOAL = "Objetivo libro E2E";

test.beforeAll(async () => {
  const store = await createWorthlineStoreUnsafe({
    databasePath: process.env.WORTHLINE_DB_PATH!,
  });
  // Journeys anteriores resetean e importan el workspace: el miembro se lee, no se
  // supone.
  const workspace = await store.workspace.readWorkspace();
  const memberId = workspace!.members[0]!.id;
  for (let index = 1; index <= 14; index += 1) {
    await store.assets.createManualAsset({
      currency: "EUR",
      // De mayor a menor: «01» es el más valioso.
      currentValueMinor: (20_000 - index) * 100,
      id: `asset_libro_${index}`,
      liquidityTier: "market",
      name: `${PREFIX} ${String(index).padStart(2, "0")}`,
      ownership: [{ memberId, shareBps: 10_000 }],
      type: "manual",
    });
  }
  store.close();
});

test("con 13+ activos, Enter añade sin enviar y lo marcado viaja aunque el buscador lo esconda", async ({
  page,
}) => {
  const actionPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) {
      actionPosts.push(request.url());
    }
  });

  await page.goto("/objetivos");
  const form = page.locator("#goalCreateForm");
  const search = form.getByRole("searchbox", { name: "Buscar un activo" });
  // Antes de hidratar, Enter es el del navegador: enviaría el formulario.
  await waitForHydration(search);

  // El libro enseña los cinco mayores del peldaño y ofrece el resto.
  await expect(
    form.getByRole("button", { name: /^Ver \d+ más de Mercado$/ }),
  ).toBeVisible();
  await expect(form.getByText(`${PREFIX} 09`)).toBeHidden();

  // Buscar señala la fila; Enter la añade, limpia y no envía nada.
  await search.fill("libro e2e 09");
  await expect(form.locator(".chipLedgerHint")).toContainText(`Enter añade ${PREFIX} 09`);
  await search.press("Enter");
  await expect(search).toHaveValue("");
  const basket = form.getByRole("complementary", { name: "Elegidos" });
  await expect(basket).toContainText(`${PREFIX} 09`);

  // Una búsqueda sin coincidencias esconde todo el libro…
  await search.fill("ninguna coincidencia posible");
  await expect(form.getByText(/Ningún activo coincide/)).toBeVisible();
  // …y lo marcado se sigue enviando.
  const posted = await form.evaluate((element) =>
    new FormData(element as HTMLFormElement).getAll("assetIds"),
  );
  expect(posted).toEqual(["asset_libro_9"]);
  expect(actionPosts, "Enter en el buscador envió el formulario").toEqual([]);

  // La × de la cesta desmarca la casilla del libro: la cesta no tiene casillas
  // propias, así que si no la desmarcara, el fondo se seguiría enviando.
  await form.getByRole("button", { name: "Borrar la búsqueda" }).click();
  const first = form.getByRole("checkbox", { name: new RegExp(`^${PREFIX} 01`) });
  await first.check();
  await expect(basket).toContainText(`${PREFIX} 01`);
  await basket.getByRole("button", { name: `Quitar ${PREFIX} 01` }).click();
  await expect(basket).not.toContainText(`${PREFIX} 01`);
  await expect(first).not.toBeChecked();

  // Y llega al servidor: el objetivo nace financiado por ese fondo.
  await form.getByLabel("Nombre").fill(GOAL);
  await form.getByLabel("Importe objetivo (EUR)").fill("5000");
  await form.getByLabel("Fecha límite").fill("2031-01-01");
  await form.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(page).toHaveURL(/[?&]ok=goal_saved/);

  const goalRow = page
    .locator(".goalRow")
    .filter({ has: page.locator(`input[name="name"][value="${GOAL}"]`) });
  await expect(goalRow.getByRole("complementary", { name: "Elegidos" })).toContainText(
    `${PREFIX} 09`,
  );

  // En un móvil de 390 px el libro apila la cesta encima y no desborda la página.
  await page.setViewportSize({ height: 844, width: 390 });
  await goalRow
    .getByRole("searchbox", { name: "Buscar un activo" })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
