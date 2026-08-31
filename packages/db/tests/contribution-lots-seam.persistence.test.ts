/**
 * Los lotes de aportación en el seam del store (#1676, fase 2 de #1528).
 *
 * Lo que este fichero fija es la aceptación del ticket: un holding puede declarar
 * varios lotes, la escalera viaja al holding del dominio para que el pool de FIRE la
 * lea, el peldaño es el dueño de la pregunta (igual que la fecha única), y **ningún
 * importe disponible se persiste** — en la tabla solo hay fechas e importes aportados.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

async function seedWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
}

async function addHolding(
  store: WorthlineStore,
  id: string,
  liquidityTier: "term-locked" | "cash",
): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1_055_658,
    id,
    liquidityTier,
    name: id,
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "manual",
  });
}

describe("replaceContributionLots (#1676)", () => {
  test("un holding a plazo declara su escalera, y la lectura la devuelve ordenada", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    expect(await store.assets.readContributionLots("pp")).toEqual([]);

    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 600_000, availableFrom: "2031-05-01" },
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);

    const lots = await store.assets.readContributionLots("pp");

    expect(lots.map((lot) => [lot.availableFrom, lot.amountMinor])).toEqual([
      ["2024-03-01", 400_000],
      ["2031-05-01", 600_000],
    ]);
  });

  test("la escalera viaja al holding del dominio, que es lo que el motor lee", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pp");

    expect(asset?.contributionLots).toEqual([
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);
  });

  test("un holding sin lotes no arrastra una lista vacía al dominio", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pp");

    expect(asset?.contributionLots).toBeUndefined();
  });

  // Reemplazo y no `push`: la lista que llega ES la declaración.
  test("escribir de nuevo reemplaza la escalera entera, sin restos de la anterior", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
      { amountMinor: 600_000, availableFrom: "2031-05-01" },
    ]);
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 900_000, availableFrom: "2033-01-01" },
    ]);

    expect(await store.assets.readContributionLots("pp")).toHaveLength(1);
  });

  test("una lista vacía borra la escalera y devuelve el holding a la fase 1", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);

    await store.assets.replaceContributionLots("pp", []);

    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });

  // El peldaño es el dueño de la pregunta (ADR 0013), igual que con la fecha única.
  test("un holding fuera del escalón a plazo no puede declarar lotes", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "caja", "cash");

    await expect(
      store.assets.replaceContributionLots("caja", [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
      ]),
    ).rejects.toThrow(/term-locked/);
  });

  test("una fecha que el calendario no tiene se rechaza, no se desplaza en silencio", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    await expect(
      store.assets.replaceContributionLots("pp", [
        { amountMinor: 400_000, availableFrom: "2035-02-30" },
      ]),
    ).rejects.toThrow(/real YYYY-MM-DD/);
  });

  test("un lote de cero o negativo no es una declaración", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    await expect(
      store.assets.replaceContributionLots("pp", [
        { amountMinor: 0, availableFrom: "2031-05-01" },
      ]),
    ).rejects.toThrow(/positive integer/);
    await expect(
      store.assets.replaceContributionLots("pp", [
        { amountMinor: -1, availableFrom: "2031-05-01" },
      ]),
    ).rejects.toThrow(/positive integer/);
  });

  test("un rechazo no deja la escalera anterior a medio borrar", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);

    await expect(
      store.assets.replaceContributionLots("pp", [
        { amountMinor: 600_000, availableFrom: "2031-05-01" },
        { amountMinor: 0, availableFrom: "2033-01-01" },
      ]),
    ).rejects.toThrow(/positive integer/);

    // La validación va ANTES del borrado, así que lo declarado sigue en pie.
    expect(await store.assets.readContributionLots("pp")).toEqual([
      expect.objectContaining({ amountMinor: 400_000, availableFrom: "2024-03-01" }),
    ]);
  });

  test("un holding que no existe se rechaza por su nombre", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    await expect(
      store.assets.replaceContributionLots("fantasma", [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
      ]),
    ).rejects.toThrow(/not found/);
  });
});
