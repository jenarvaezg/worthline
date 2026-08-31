/**
 * Las acciones que declaran la escalera de un plan de pensiones (#1676, fase 2 de
 * #1528).
 *
 * Lo que se fija aquí es el contrato del ticket: se declara FECHA e IMPORTE (nunca «lo
 * disponible hoy»), la escalera se construye lote a lote sobre un seam que reemplaza
 * de una pieza, el peldaño es el dueño de la pregunta, y quitar un lote deja los demás
 * en pie.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { addContributionLotAction, removeContributionLotAction } from "./actions";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const TODAY = "2026-08-31";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "mJ";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function runAdd(fd: FormData, store: WorthlineStore): Promise<string> {
  return runAction(() => addContributionLotAction(fd, store, CLOCK));
}

async function runRemove(fd: FormData, store: WorthlineStore): Promise<string> {
  return runAction(() => removeContributionLotAction(fd, store, CLOCK));
}

async function runAction(call: () => Promise<never>): Promise<string> {
  try {
    await call();
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

async function seed(
  liquidityTier: "term-locked" | "cash" = "term-locked",
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1_055_658,
    id: "pp",
    liquidityTier,
    name: "Plan de pensiones",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "manual",
  });
  return store;
}

describe("addContributionLotAction (#1676)", () => {
  test("declara un lote con su fecha y su importe", async () => {
    const store = await seed();

    const url = await runAdd(
      form({ id: "pp", lotAmount: "4000", lotAvailableFrom: "2024-03-01" }),
      store,
    );

    expect(url).toContain("ok=contribution_lot_saved");
    expect(await store.assets.readContributionLots("pp")).toEqual([
      expect.objectContaining({ amountMinor: 400_000, availableFrom: "2024-03-01" }),
    ]);
  });

  test("la escalera se construye lote a lote, sin perder los anteriores", async () => {
    const store = await seed();

    await runAdd(
      form({ id: "pp", lotAmount: "4000", lotAvailableFrom: "2024-03-01" }),
      store,
    );
    await runAdd(
      form({ id: "pp", lotAmount: "6000", lotAvailableFrom: "2031-05-01" }),
      store,
    );

    const lots = await store.assets.readContributionLots("pp");

    expect(lots.map((lot) => [lot.availableFrom, lot.amountMinor])).toEqual([
      ["2024-03-01", 400_000],
      ["2031-05-01", 600_000],
    ]);
  });

  // El peldaño es el dueño de la pregunta (ADR 0013), igual que la fecha única.
  test("un holding fuera del escalón a plazo no puede declarar lotes", async () => {
    const store = await seed("cash");

    const url = await runAdd(
      form({ id: "pp", lotAmount: "4000", lotAvailableFrom: "2024-03-01" }),
      store,
    );

    expect(url).toContain("error=");
    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });

  test("una fecha que el calendario no tiene vuelve al formulario con lo tecleado", async () => {
    const store = await seed();

    const url = await runAdd(
      form({ id: "pp", lotAmount: "4000", lotAvailableFrom: "2035-02-30" }),
      store,
    );

    expect(url).toContain("form=contributionLot");
    expect(url).toContain("v_lotAvailableFrom=2035-02-30");
    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });

  test("un lote sin importe, o de cero, no es una declaración", async () => {
    const store = await seed();

    expect(
      await runAdd(
        form({ id: "pp", lotAmount: "", lotAvailableFrom: "2031-05-01" }),
        store,
      ),
    ).toContain("form=contributionLot");
    expect(
      await runAdd(
        form({ id: "pp", lotAmount: "0", lotAvailableFrom: "2031-05-01" }),
        store,
      ),
    ).toContain("form=contributionLot");
    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });

  test("un lote sin fecha se rechaza: es la mitad que hace útil al lote", async () => {
    const store = await seed();

    const url = await runAdd(
      form({ id: "pp", lotAmount: "4000", lotAvailableFrom: "" }),
      store,
    );

    expect(url).toContain("form=contributionLot");
    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });
});

describe("removeContributionLotAction (#1676)", () => {
  test("quita un lote y deja los demás en pie", async () => {
    const store = await seed();
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
      { amountMinor: 600_000, availableFrom: "2031-05-01" },
    ]);
    const [first] = await store.assets.readContributionLots("pp");

    const url = await runRemove(form({ id: "pp", lotId: first!.id }), store);

    expect(url).toContain("ok=contribution_lot_removed");
    expect(await store.assets.readContributionLots("pp")).toEqual([
      expect.objectContaining({ amountMinor: 600_000, availableFrom: "2031-05-01" }),
    ]);
  });

  // Una pantalla vieja no es un error del usuario: lo que pedía ya se cumple.
  test("un id que ya no está deja la escalera intacta y no revienta", async () => {
    const store = await seed();
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);

    const url = await runRemove(form({ id: "pp", lotId: "fantasma" }), store);

    expect(url).toContain("ok=contribution_lot_removed");
    expect(await store.assets.readContributionLots("pp")).toHaveLength(1);
  });

  test("quitar el último lote devuelve el holding a la fase 1", async () => {
    const store = await seed();
    await store.assets.replaceContributionLots("pp", [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
    ]);
    const [only] = await store.assets.readContributionLots("pp");

    await runRemove(form({ id: "pp", lotId: only!.id }), store);

    expect(await store.assets.readContributionLots("pp")).toEqual([]);
  });
});
