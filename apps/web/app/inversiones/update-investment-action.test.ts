/**
 * La ficha de una inversión valida el identificador que el INSTRUMENTO puede tener
 * (#1746, decisión 9 del mapa #1454), y ofrece el reintento que salud de datos
 * promete cuando el plan quedó «identificado, sin cotizar».
 *
 * Antes de esta slice la ficha solo sabía enseñar un campo, y ese campo era el ISIN:
 * el código DGS de un plan no tenía dónde teclearse, así que se conservaba con un
 * parche (guardar la ficha no podía tocarlo) y el estado «plan con ISIN» era un aviso
 * que el usuario no podía seguir. Aquí se cierra en la escritura.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const seed = vi.hoisted(() => ({ resolvePlanSymbolFromDgs: vi.fn() }));

vi.mock("@web/inversiones/plan-symbol-seed", () => ({
  resolvePlanSymbolFromDgs: seed.resolvePlanSymbolFromDgs,
}));

import { updateInvestmentAction } from "./update-investment-action";

const NOW = "2026-09-07T10:00:00.000Z";
const PLAN_ID = "asset_plan";

function fichaForm(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("currentUrl", "/patrimonio/wl_hld_plan");
  data.set("name", "MyInvestor S&P 500 PP");
  data.set("instrument", "pension_plan");
  data.set("liquidityTier", "term-locked");
  data.set("priceProvider", "finect");
  data.set("providerSymbol", "");
  // Lo que la ficha de un plan renderiza: la clase del campo viaja declarada, y es
  // lo que distingue «lo he borrado» de «no había campo».
  data.set("securityIdKind", "dgs");
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

async function seedPlan(
  store: WorthlineStore,
  overrides: { providerSymbol?: string } = {},
): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: PLAN_ID,
    instrument: "pension_plan",
    liquidityTier: "term-locked",
    name: "MyInvestor S&P 500 PP",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "finect",
    securityId: { kind: "dgs", value: "N5394" },
    ...(overrides.providerSymbol ? { providerSymbol: overrides.providerSymbol } : {}),
  });
}

/** El estado que solo nace del import de documento (#1416): valor puesto, clase nula. */
async function seedIdentifierWithNoKind(store: WorthlineStore): Promise<void> {
  await seedPlan(store);
  await store.assets.updateInvestmentAsset({
    id: PLAN_ID,
    liquidityTier: "term-locked",
    name: "MyInvestor S&P 500 PP",
    priceProvider: "finect",
    securityId: { kind: null, value: "raro" },
  });
}

/** What the redirect said, decoded — `+` for spaces included. */
function errorMessageOf(digest: string): string {
  const url = digest.split(";")[2] ?? "";
  return new URL(url, "https://x.test").searchParams.get("error") ?? "";
}

/** The action always redirects; the digest is where it went. */
async function run(store: WorthlineStore, formData: FormData): Promise<string> {
  try {
    await updateInvestmentAction(PLAN_ID, formData, store, fixedClock(NOW));
    throw new Error("action did not redirect");
  } catch (error: unknown) {
    const e = error as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw error;
  }
}

describe("el campo de identidad de la ficha es el del instrumento (#1746)", () => {
  let store: WorthlineStore;

  beforeEach(async () => {
    seed.resolvePlanSymbolFromDgs.mockReset();
    store = await createInMemoryStore();
    await seedPlan(store);
  });

  test("acepta el código DGS del plan, tipado como tal", async () => {
    const digest = await run(store, fichaForm({ securityId: "n-5396" }));

    expect(digest).toContain("ok=");
    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    // Normalizado a la forma en la que se compara: dos personas con el mismo plan
    // comparten ficha de catálogo solo si el código es el mismo texto.
    expect(saved?.securityId).toEqual({ kind: "dgs", value: "N5396" });
  });

  test("rechaza un ISIN en el campo de un plan, con el porqué", async () => {
    const digest = await run(store, fichaForm({ securityId: "IE00B52MJY50" }));

    expect(digest).toContain("error=");
    expect(errorMessageOf(digest)).toContain("DGS");
    // Y no ha escrito nada: el código que ya tenía sigue ahí.
    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("rechaza el código del FONDO nombrando la trampa del papel", async () => {
    const message = errorMessageOf(await run(store, fichaForm({ securityId: "F2244" })));

    expect(message).toContain("F2244");
    expect(message).toContain("fondo de pensiones");
  });

  test("un envío con el campo en blanco declara «sin identificador», no lo inventa", async () => {
    await run(store, fichaForm({ securityId: "" }));

    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.securityId).toBeUndefined();
  });
});

describe("guardar la ficha no borra el identificador que no enseñó", () => {
  let store: WorthlineStore;

  beforeEach(async () => {
    seed.resolvePlanSymbolFromDgs.mockReset();
    store = await createInMemoryStore();
  });

  test("una ficha sin campo de identidad (cripto) conserva lo guardado", async () => {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: PLAN_ID,
      instrument: "crypto",
      liquidityTier: "market",
      name: "Bitcoin",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      priceProvider: "coingecko",
      providerSymbol: "bitcoin",
      securityId: { kind: "isin", value: "IE00B52MJY50" },
    });

    const data = new FormData();
    data.set("currentUrl", "/patrimonio/wl_hld_plan");
    data.set("instrument", "crypto");
    data.set("name", "Bitcoin renombrado");
    data.set("liquidityTier", "market");
    data.set("priceProvider", "coingecko");
    data.set("providerSymbol", "bitcoin");

    await run(store, data);

    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.name).toBe("Bitcoin renombrado");
    // Renombrar no puede tirar una identidad que el formulario no llegó a mostrar.
    expect(saved?.securityId).toEqual({ kind: "isin", value: "IE00B52MJY50" });
  });

  test("un plan que guarda un ISIN conserva el valor mientras no se teclee el código", async () => {
    await seedPlan(store);
    await store.assets.updateInvestmentAsset({
      id: PLAN_ID,
      liquidityTier: "term-locked",
      name: "MyInvestor S&P 500 PP",
      priceProvider: "finect",
      securityId: { kind: "isin", value: "IE00B52MJY50" },
    });

    await run(store, fichaForm({ securityId: "" }));

    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    // La caja del código DGS salió vacía porque lo guardado no es un código DGS: la
    // ficha lo cita en una línea, y guardar sin teclear no lo borra.
    expect(saved?.securityId).toEqual({ kind: "isin", value: "IE00B52MJY50" });
  });

  // #1770: el estado que solo nace del import de documento (#1416) — valor puesto,
  // clase nula. Es exactamente el dato que la señal `UNCLASSIFIED_SECURITY_ID`
  // manda a reparar en esta ficha, y era la única pista para escribir el bueno.
  test("un valor preservado SIN CLASE sobrevive a un guardado que no lo teclea (#1770)", async () => {
    await seedIdentifierWithNoKind(store);

    await run(store, fichaForm({ securityId: "" }));

    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.securityId).toEqual({ kind: null, value: "raro" });
  });

  test("teclear el código bueno encima del valor sin clase SÍ lo re-tipa (#1770)", async () => {
    await seedIdentifierWithNoKind(store);

    await run(store, fichaForm({ securityId: "N5396" }));

    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.securityId).toEqual({ kind: "dgs", value: "N5396" });
  });
});

describe("el reintento del plan: «búscame el símbolo por el código DGS»", () => {
  let store: WorthlineStore;

  beforeEach(async () => {
    seed.resolvePlanSymbolFromDgs.mockReset();
    store = await createInMemoryStore();
    await seedPlan(store);
  });

  test("con Finect vivo, el símbolo queda sembrado del código", async () => {
    seed.resolvePlanSymbolFromDgs.mockResolvedValue(
      "N5394-Myinvestor_indexado_sp_500_pp",
    );

    const digest = await run(
      store,
      fichaForm({ securityId: "N5394", seedPlanSymbol: "1" }),
    );

    expect(digest).toContain("ok=");
    expect(seed.resolvePlanSymbolFromDgs).toHaveBeenCalledWith("N5394");
    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.providerSymbol).toBe("N5394-Myinvestor_indexado_sp_500_pp");
    expect(saved?.priceProvider).toBe("finect");
  });

  test("con Finect callado no se guarda a medias: se dice y se puede reintentar", async () => {
    seed.resolvePlanSymbolFromDgs.mockResolvedValue(null);

    const digest = await run(
      store,
      fichaForm({ securityId: "N9999", seedPlanSymbol: "1" }),
    );

    expect(digest).toContain("error=");
    expect(errorMessageOf(digest)).toContain("N9999");
    const saved = await store.assets.readInvestmentAssetById(PLAN_ID);
    expect(saved?.providerSymbol).toBeUndefined();
    // El estado legítimo se conserva entero: identificado, sin cotizar.
    expect(saved?.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("sin código no hay nada que buscar, y se dice antes de llamar a nadie", async () => {
    const digest = await run(store, fichaForm({ securityId: "", seedPlanSymbol: "1" }));

    expect(digest).toContain("error=");
    expect(errorMessageOf(digest)).toContain("código DGS");
    expect(seed.resolvePlanSymbolFromDgs).not.toHaveBeenCalled();
  });
});
