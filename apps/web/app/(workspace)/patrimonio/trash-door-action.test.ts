/**
 * The Papelera door, through its Server Action (#1549).
 *
 * `trash-gate.persistence.test.ts` pins the refusal at the store seam; this pins the
 * half only the action owns — the sentence the owner reads, and the «Lo vendí» exit,
 * which records the closing sale through the ordinary operation command before it
 * archives anything.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, derivePosition, fixedClock } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { deleteAssetAction } from "./actions";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const TODAY = "2026-08-23";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "m1";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await deleteAssetAction(fd, store, CLOCK);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return decodeURIComponent(e.digest.replace(/\+/g, " "));
    }
    throw err;
  }
}

/** A workspace whose only investment holds 100 participaciones bought at 60 €. */
async function seedFund(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "a_groupama",
    instrument: "fund",
    name: "Groupama Trésorerie",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  await store.operations.recordOperation({
    assetId: "a_groupama",
    currency: "EUR",
    executedAt: "2026-01-15",
    id: "op_buy",
    kind: "buy",
    pricePerUnit: "60",
    units: "100",
  });
  return store;
}

async function positionOf(store: WorthlineStore) {
  return derivePosition(await store.operations.readOperations("a_groupama"), {
    assetId: "a_groupama",
    currency: "EUR",
  });
}

async function trashedIds(store: WorthlineStore): Promise<string[]> {
  return (await store.readTrash()).assets.map((asset) => asset.id);
}

describe("deleteAssetAction — the door refuses to evaporate money (#1549)", () => {
  test("with units inside and no exit, it says what is inside and offers the three", async () => {
    const store = await seedFund();

    const url = await runAction(form({ id: "a_groupama" }), store);

    expect(url).toContain("error=");
    expect(url).toContain("conserva 100 participaciones");
    expect(url).toContain("lo vendiste, lo traspasaste, o fue un error de registro");
    expect(await trashedIds(store)).toEqual([]);

    store.close();
  });

  test("«error de registro» archives it with the value inside, as declared", async () => {
    const store = await seedFund();

    const url = await runAction(form({ exit: "mis_entry", id: "a_groupama" }), store);

    expect(url).toContain("deleted_recoverable");
    expect(await trashedIds(store)).toEqual(["a_groupama"]);
    // The ledger is untouched: a restore has to bring the holding back as it was.
    expect((await positionOf(store)).currentUnits).toBe("100");

    store.close();
  });
});

describe("deleteAssetAction — «Lo vendí» records the sale before archiving (#1549)", () => {
  test("closes the position at the importe stated, then sends it to the Papelera", async () => {
    const store = await seedFund();

    const url = await runAction(
      form({
        exit: "sold",
        id: "a_groupama",
        soldAmount: "7642,00",
        soldAt: "2026-08-01",
      }),
      store,
    );

    expect(url).toContain("deleted_recoverable");
    expect(await trashedIds(store)).toEqual(["a_groupama"]);

    const operations = await store.operations.readOperations("a_groupama");
    expect(operations).toHaveLength(2);
    const sell = operations.find((operation) => operation.kind === "sell");
    expect(sell).toMatchObject({ executedAt: "2026-08-01", units: "100" });
    // The money did NOT evaporate: it is a realized sale, and the position is closed.
    expect((await positionOf(store)).currentUnits).toBe("0");

    store.close();
  });

  test("without an importe nothing is written — no sale, and the holding stays live", async () => {
    const store = await seedFund();

    const url = await runAction(
      form({ exit: "sold", id: "a_groupama", soldAmount: "", soldAt: "2026-08-01" }),
      store,
    );

    expect(url).toContain("Escribe el importe que recibiste");
    expect(await store.operations.readOperations("a_groupama")).toHaveLength(1);
    expect(await trashedIds(store)).toEqual([]);

    store.close();
  });
});

describe("deleteAssetAction — a cartera's cash box (ADR 0085, #1549)", () => {
  test("names the cartera and refuses, exit or no exit", async () => {
    const store = await seedFund();
    const portfolio = await store.managedPortfolios.createManagedPortfolio({
      cashOwnership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      memberHoldingIds: [],
      name: "Cartera Indexada Metal",
      scopeId: MEMBER_ID,
    });

    const url = await runAction(
      form({ exit: "mis_entry", id: portfolio.holdingIds[0] as string }),
      store,
    );

    expect(url).toContain("Cartera Indexada Metal");
    expect(url).toContain("la casilla quedará como una cuenta normal");
    expect(await trashedIds(store)).toEqual([]);

    store.close();
  });
});
