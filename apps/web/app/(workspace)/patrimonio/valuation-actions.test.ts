/**
 * Action-level tests for the valuation actions (PRD #1114 migration) — hand-set
 * asset value / liability balance and the housing valuation-anchor CRUD
 * (add / update / delete, ADR 0020). Before this slice these five actions had NO
 * tests through their interface; here they run against an in-memory store,
 * asserting the persisted value, the anchor seam's ripple onto /historico's
 * snapshots, the R9 housing guard, the manual-valuation domain guard, validation
 * errors, not-found paths, and demo write-gating.
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addValuationAnchorAction,
  deleteValuationAnchorAction,
  updateAssetValuationAction,
  updateLiabilityBalanceAction,
  updateValuationAnchorAction,
} from "./actions";

let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

const TODAY = "2026-07-02";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "mJ";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function runAction(
  action: (fd: FormData, ...a: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((s) => s.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

async function assetValue(
  store: WorthlineStore,
  id: string,
): Promise<number | undefined> {
  return (await store.assets.readAssets()).find((a) => a.id === id)?.currentValue
    .amountMinor;
}

async function liabilityBalance(
  store: WorthlineStore,
  id: string,
): Promise<number | undefined> {
  return (await store.liabilities.readLiabilities()).find((l) => l.id === id)
    ?.currentBalance.amountMinor;
}

async function initStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/** Seed a plain hand-valued asset (manual liquidity), the value-update model. */
async function seedManualAsset(): Promise<WorthlineStore> {
  const store = await initStore();
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 5_000_00,
    id: "cuadro",
    liquidityTier: "illiquid",
    name: "Cuadro",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "manual",
  });
  return store;
}

/** Seed a real_estate asset — the only kind that accepts valuation anchors (R9). */
async function seedHousing(): Promise<WorthlineStore> {
  const store = await initStore();
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "real_estate",
  });
  return store;
}

async function seedLiability(): Promise<WorthlineStore> {
  const store = await initStore();
  await store.liabilities.createLiability({
    balanceMinor: 10_000_00,
    currency: "EUR",
    id: "prestamo",
    name: "Préstamo",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "debt",
  });
  return store;
}

describe("updateAssetValuationAction", () => {
  test("hand-sets the asset value", async () => {
    const store = await seedManualAsset();

    const url = await runAction(
      updateAssetValuationAction,
      form({ id: "cuadro", currentValue: "7.500,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("saved");
    expect(await assetValue(store, "cuadro")).toBe(7_500_00);

    store.close();
  });

  test("rejects an invalid value without changing the asset", async () => {
    const store = await seedManualAsset();

    const url = await runAction(
      updateAssetValuationAction,
      form({ id: "cuadro", currentValue: "no-es-un-numero" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await assetValue(store, "cuadro")).toBe(5_000_00);

    store.close();
  });

  test("refuses to hand-edit a derived investment holding (domain guard)", async () => {
    const store = await initStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 3_000_00,
      id: "fondo",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "investment",
    });

    const url = await runAction(
      updateAssetValuationAction,
      form({ id: "fondo", currentValue: "4.000,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    // An investment's value derives from its lots (reads 0 here); the guard
    // rejected the hand-edit, so no manual 4.000,00 override was applied.
    expect(await assetValue(store, "fondo")).toBe(0);

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the value untouched", async () => {
    const store = await seedManualAsset();
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateAssetValuationAction,
      form({ id: "cuadro", currentValue: "7.500,00" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await assetValue(store, "cuadro")).toBe(5_000_00);

    store.close();
  });
});

describe("updateLiabilityBalanceAction", () => {
  test("hand-sets the liability balance", async () => {
    const store = await seedLiability();

    const url = await runAction(
      updateLiabilityBalanceAction,
      form({ id: "prestamo", balance: "8.000,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("saved");
    expect(await liabilityBalance(store, "prestamo")).toBe(8_000_00);

    store.close();
  });

  test("rejects an invalid balance without changing the liability", async () => {
    const store = await seedLiability();

    const url = await runAction(
      updateLiabilityBalanceAction,
      form({ id: "prestamo", balance: "no-es-un-numero" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await liabilityBalance(store, "prestamo")).toBe(10_000_00);

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the balance untouched", async () => {
    const store = await seedLiability();
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateLiabilityBalanceAction,
      form({ id: "prestamo", balance: "8.000,00" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await liabilityBalance(store, "prestamo")).toBe(10_000_00);

    store.close();
  });
});

describe("addValuationAnchorAction", () => {
  test("persists a market appraisal and ripples a snapshot at its date", async () => {
    const store = await seedHousing();

    const url = await runAction(
      addValuationAnchorAction,
      form({
        id: "piso",
        valuationDate: "2026-05-01",
        anchorValue: "150.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("anchor_added");

    const anchors = await store.assets.readValuationAnchors("piso");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      valuationDate: "2026-05-01",
      valueMinor: 150_000_00,
      adjustsPriorCurve: true,
    });
    expect(await grossAt(store, "2026-05-01")).toBe(150_000_00);

    store.close();
  });

  test("rejects a non-positive anchor value without persisting anything", async () => {
    const store = await seedHousing();

    const url = await runAction(
      addValuationAnchorAction,
      form({
        id: "piso",
        valuationDate: "2026-05-01",
        anchorValue: "0",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(0);

    store.close();
  });

  test("refuses a non-housing asset — tasaciones only apply to real estate (R9)", async () => {
    const store = await seedManualAsset();

    const url = await runAction(
      addValuationAnchorAction,
      form({
        id: "cuadro",
        valuationDate: "2026-05-01",
        anchorValue: "150.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.assets.readValuationAnchors("cuadro")).toHaveLength(0);

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedHousing();
    mockPersonaCookie = "familia";

    const url = await runAction(
      addValuationAnchorAction,
      form({
        id: "piso",
        valuationDate: "2026-05-01",
        anchorValue: "150.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(0);

    store.close();
  });
});

describe("updateValuationAnchorAction", () => {
  async function seedWithAnchor(): Promise<{ store: WorthlineStore; anchorId: string }> {
    const store = await seedHousing();
    await runAction(
      addValuationAnchorAction,
      form({
        id: "piso",
        valuationDate: "2026-05-01",
        anchorValue: "150.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    const anchorId = (await store.assets.readValuationAnchors("piso"))[0]!.id;
    return { store, anchorId };
  }

  test("patches the anchor value and re-ripples the snapshot at its date", async () => {
    const { store, anchorId } = await seedWithAnchor();

    const url = await runAction(
      updateValuationAnchorAction,
      form({
        id: "piso",
        anchorId,
        valuationDate: "2026-05-01",
        anchorValue: "160.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("anchor_saved");

    expect((await store.assets.readValuationAnchors("piso"))[0]!.valueMinor).toBe(
      160_000_00,
    );
    expect(await grossAt(store, "2026-05-01")).toBe(160_000_00);

    store.close();
  });

  test("an unknown anchorId reports not-found without touching the existing anchor", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      updateValuationAnchorAction,
      form({
        id: "piso",
        anchorId: "ghost",
        valuationDate: "2026-05-01",
        anchorValue: "160.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.assets.readValuationAnchors("piso"))[0]!.valueMinor).toBe(
      150_000_00,
    );

    store.close();
  });

  test("rejects a non-positive value without changing the anchor", async () => {
    const { store, anchorId } = await seedWithAnchor();

    const url = await runAction(
      updateValuationAnchorAction,
      form({
        id: "piso",
        anchorId,
        valuationDate: "2026-05-01",
        anchorValue: "0",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.assets.readValuationAnchors("piso"))[0]!.valueMinor).toBe(
      150_000_00,
    );

    store.close();
  });

  test("blocks the mutation in demo mode", async () => {
    const { store, anchorId } = await seedWithAnchor();
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateValuationAnchorAction,
      form({
        id: "piso",
        anchorId,
        valuationDate: "2026-05-01",
        anchorValue: "160.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect((await store.assets.readValuationAnchors("piso"))[0]!.valueMinor).toBe(
      150_000_00,
    );

    store.close();
  });
});

describe("deleteValuationAnchorAction", () => {
  async function seedWithAnchor(): Promise<{ store: WorthlineStore; anchorId: string }> {
    const store = await seedHousing();
    await runAction(
      addValuationAnchorAction,
      form({
        id: "piso",
        valuationDate: "2026-05-01",
        anchorValue: "150.000,00",
        adjustsPriorCurve: "on",
      }),
      store,
      CLOCK,
    );
    const anchorId = (await store.assets.readValuationAnchors("piso"))[0]!.id;
    return { store, anchorId };
  }

  test("removes the anchor", async () => {
    const { store, anchorId } = await seedWithAnchor();

    const url = await runAction(
      deleteValuationAnchorAction,
      form({ id: "piso", anchorId }),
      store,
      CLOCK,
    );
    expect(url).toContain("anchor_deleted");
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(0);

    store.close();
  });

  test("an unknown anchorId reports not-found without touching the existing anchor", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      deleteValuationAnchorAction,
      form({ id: "piso", anchorId: "ghost" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);

    store.close();
  });

  test("blocks the mutation in demo mode", async () => {
    const { store, anchorId } = await seedWithAnchor();
    mockPersonaCookie = "familia";

    const url = await runAction(
      deleteValuationAnchorAction,
      form({ id: "piso", anchorId }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);

    store.close();
  });
});
