/**
 * The declared availability date at the store seam (#1528, ADR 0100).
 *
 * Three things this file pins, because all three are the ticket's own acceptance:
 * only the rung that ADR 0013 defines with a plazo can carry a date, the date
 * round-trips onto the domain holding so the FIRE pool can read it, and clearing
 * it goes back to «nadie lo ha dicho» rather than to some third state.
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
    currentValueMinor: 497_955,
    id,
    liquidityTier,
    name: id,
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "manual",
  });
}

describe("setAvailableFrom (#1528)", () => {
  test("un holding a plazo declara su fecha, y la lectura la devuelve", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    expect(await store.assets.readAvailableFrom("pp")).toBeNull();

    await store.assets.setAvailableFrom("pp", "2035-06-01");

    expect(await store.assets.readAvailableFrom("pp")).toBe("2035-06-01");
  });

  test("la fecha viaja al holding del dominio, que es quien la lee el motor", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");
    await store.assets.setAvailableFrom("pp", "2035-06-01");

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pp");

    expect(asset?.availableFrom).toBe("2035-06-01");
  });

  test("null la devuelve a «nadie lo ha dicho», no a un tercer estado", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");
    await store.assets.setAvailableFrom("pp", "2035-06-01");

    await store.assets.setAvailableFrom("pp", null);

    expect(await store.assets.readAvailableFrom("pp")).toBeNull();
    const asset = (await store.assets.readAssets()).find((a) => a.id === "pp");
    expect(asset?.availableFrom).toBeUndefined();
  });

  test("un escalón que no reclama plazo no puede declarar fecha", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "cuenta", "cash");

    await expect(store.assets.setAvailableFrom("cuenta", "2035-06-01")).rejects.toThrow(
      /term-locked/,
    );
  });

  test("una fecha con forma inválida se rechaza en el seam, no se guarda", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    await addHolding(store, "pp", "term-locked");

    await expect(store.assets.setAvailableFrom("pp", "01/06/2035")).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(await store.assets.readAvailableFrom("pp")).toBeNull();
  });
});
