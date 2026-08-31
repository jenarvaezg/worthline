/**
 * La acción que declara desde cuándo se puede tocar un holding (#1528, ADR 0100).
 *
 * Lo que se fija aquí es el contrato del ticket, no la mecánica del formulario: se
 * guarda una FECHA, vacío BORRA la declaración, la fecha solo la admite el escalón
 * que ADR 0013 define con un plazo, y guardarla no re-deriva ni un snapshot — es una
 * lectura del reparto, no un hecho fechado.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { setHoldingAvailableFromAction } from "./actions";

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

async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await setHoldingAvailableFromAction(fd, store, CLOCK);
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
    currentValueMinor: 4_979_55,
    id: "pp",
    liquidityTier,
    name: "Plan de pensiones",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "manual",
  });
  return store;
}

describe("setHoldingAvailableFromAction (#1528)", () => {
  test("guarda la fecha declarada de un holding a plazo", async () => {
    const store = await seed();

    const url = await runAction(form({ availableFrom: "2035-06-01", id: "pp" }), store);

    expect(url).toContain("ok=available_from_saved");
    expect(await store.assets.readAvailableFrom("pp")).toBe("2035-06-01");

    store.close();
  });

  test("vacío borra la declaración y vuelve a «nadie lo ha dicho»", async () => {
    const store = await seed();
    await runAction(form({ availableFrom: "2035-06-01", id: "pp" }), store);

    const url = await runAction(form({ availableFrom: "", id: "pp" }), store);

    expect(url).toContain("ok=available_from_cleared");
    expect(await store.assets.readAvailableFrom("pp")).toBeNull();

    store.close();
  });

  test("un día que no existe se rechaza en vez de rodar al mes siguiente", async () => {
    const store = await seed();

    // `2035-02-30` pasa el patrón AAAA-MM-DD y `Date` lo desplaza al 1 de marzo:
    // guardarlo sería un bloqueo que el usuario no ha declarado.
    const url = await runAction(form({ availableFrom: "2035-02-30", id: "pp" }), store);

    expect(url).toContain("error=");
    // El error vuelve al formulario que lo produjo, con lo tecleado intacto.
    expect(url).toContain("form=availableFrom");
    expect(url).toContain("v_availableFrom=2035-02-30");
    expect(await store.assets.readAvailableFrom("pp")).toBeNull();

    store.close();
  });

  test("un escalón que no declara plazo no puede declarar fecha", async () => {
    const store = await seed("cash");

    const url = await runAction(form({ availableFrom: "2035-06-01", id: "pp" }), store);

    expect(url).toContain("error=");
    expect(await store.assets.readAvailableFrom("pp")).toBeNull();

    store.close();
  });

  test("declarar la fecha no re-deriva ningún snapshot: no es un hecho fechado", async () => {
    const store = await seed();
    const before = await store.snapshots.readSnapshots();

    await runAction(form({ availableFrom: "2035-06-01", id: "pp" }), store);

    expect(await store.snapshots.readSnapshots()).toEqual(before);

    store.close();
  });
});
