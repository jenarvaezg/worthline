/**
 * La escritura de la ficha tiene que saber devolver a su sitio un identificador
 * que nadie supo clasificar (#1770).
 *
 * `kind: null` solo nace del import de documento (#1416): un valor real que
 * alguien tecleó una vez y que el clasificador no reconoce. Antes de esta slice
 * la entrada de `updateInvestmentAsset` solo aceptaba un par TIPADO, así que la
 * guarda que conserva lo que el formulario no supo enseñar no tenía por dónde
 * pasarlo — y guardar la ficha lo borraba en silencio.
 *
 * Ojo a la asimetría, que es la decisión: el alta (`createInvestmentAsset`) sigue
 * aceptando solo par tipado. Declarar es otra cosa que restaurar.
 */

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

async function seedFund() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo raro",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
  });
  return store;
}

describe("updateInvestmentAsset y el par preservado sin clase (#1770)", () => {
  test("escribe el valor verbatim con su clase nula, sin validarlo por clase", async () => {
    const store = await seedFund();
    try {
      await store.assets.updateInvestmentAsset({
        id: "fund",
        liquidityTier: "market",
        name: "Fondo raro",
        securityId: { kind: null, value: "LU-1234" },
      });

      // Ni se rechaza por no ser un ISIN ni se re-tipa a nada: se conserva.
      expect((await store.assets.readInvestmentAssetById("fund"))?.securityId).toEqual({
        kind: null,
        value: "LU-1234",
      });
    } finally {
      store.close();
    }
  });

  test("un valor en blanco sigue limpiando las dos columnas, clase incluida", async () => {
    const store = await seedFund();
    try {
      await store.assets.updateInvestmentAsset({
        id: "fund",
        liquidityTier: "market",
        name: "Fondo raro",
        securityId: { kind: null, value: "   " },
      });

      // Una clase sin nada debajo reclamaría una identidad que la fila no tiene.
      expect(
        (await store.assets.readInvestmentAssetById("fund"))?.securityId,
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("un par tipado escrito encima re-tipa la fila: el arreglo sigue funcionando", async () => {
    const store = await seedFund();
    try {
      await store.assets.updateInvestmentAsset({
        id: "fund",
        liquidityTier: "market",
        name: "Fondo raro",
        securityId: { kind: null, value: "LU-1234" },
      });
      await store.assets.updateInvestmentAsset({
        id: "fund",
        liquidityTier: "market",
        name: "Fondo raro",
        securityId: { kind: "isin", value: "IE00B52MJY50" },
      });

      expect((await store.assets.readInvestmentAssetById("fund"))?.securityId).toEqual({
        kind: "isin",
        value: "IE00B52MJY50",
      });
    } finally {
      store.close();
    }
  });

  // El invariante que NO se mueve: nadie escribe clase nula sobre un valor que SÍ
  // se reconoce. El escritor no se cree la clase que le pasan — la clasifica en el
  // borde, con la misma función que el import (`preservedSecurityId`).
  test("una clase nula sobre un valor reconocible no se cree: se clasifica", async () => {
    const store = await seedFund();
    try {
      await store.assets.updateInvestmentAsset({
        id: "fund",
        liquidityTier: "market",
        name: "Fondo raro",
        securityId: { kind: null, value: "ie00b52mjy50" },
      });

      expect((await store.assets.readInvestmentAssetById("fund"))?.securityId).toEqual({
        kind: "isin",
        value: "IE00B52MJY50",
      });
    } finally {
      store.close();
    }
  });

  test("un par tipado que no valida por su clase se sigue rechazando", async () => {
    const store = await seedFund();
    try {
      await expect(
        store.assets.updateInvestmentAsset({
          id: "fund",
          liquidityTier: "market",
          name: "Fondo raro",
          securityId: { kind: "isin", value: "N5394" },
        }),
      ).rejects.toThrow(/ISIN/);
    } finally {
      store.close();
    }
  });
});
