/**
 * Action-level tests for the holding lifecycle actions (PRD #1103 / #1106 —
 * soft-delete, restore, hard-delete, empty-trash) plus warning acknowledgement.
 * Before this file these eight actions had NO tests through their interface;
 * here they run against an in-memory store, asserting each success key in the
 * redirect digest AND the store's actual state (item in trash / gone / restored
 * / warning overridden), the not-found error paths, and demo write-gating.
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
  restoreAssetAction,
  restoreLiabilityAction,
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
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(
  action: (fd: FormData, ...args: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

/** Seed a workspace with one asset ("cash") and one liability ("card"). */
async function seedHoldings(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 1_000_00,
    currency: "EUR",
    id: "card",
    name: "Tarjeta",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "debt",
  });
  return store;
}

async function assetIds(store: WorthlineStore): Promise<string[]> {
  return (await store.assets.readAssets()).map((a) => a.id);
}

async function liabilityIds(store: WorthlineStore): Promise<string[]> {
  return (await store.liabilities.readLiabilities()).map((l) => l.id);
}

async function trashedAssetIds(store: WorthlineStore): Promise<string[]> {
  return (await store.readTrash()).assets.map((a) => a.id);
}

async function trashedLiabilityIds(store: WorthlineStore): Promise<string[]> {
  return (await store.readTrash()).liabilities.map((l) => l.id);
}

describe("deleteAssetAction", () => {
  test("soft-deletes the asset — it leaves the live set and lands in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(deleteAssetAction, form({ id: "cash" }), store, CLOCK);
    expect(url).toContain("deleted_recoverable");

    expect(await assetIds(store)).not.toContain("cash");
    expect(await trashedAssetIds(store)).toContain("cash");

    store.close();
  });

  test("an unknown id reports not-found without touching the live set", async () => {
    const store = await seedHoldings();

    const url = await runAction(deleteAssetAction, form({ id: "ghost" }), store, CLOCK);
    expect(url).toContain("error=");
    expect(await assetIds(store)).toContain("cash");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedHoldings();
    mockPersonaCookie = "familia";

    const url = await runAction(deleteAssetAction, form({ id: "cash" }), store, CLOCK);
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await assetIds(store)).toContain("cash");
    expect(await trashedAssetIds(store)).toHaveLength(0);

    store.close();
  });
});

describe("deleteLiabilityAction", () => {
  test("soft-deletes the liability — it leaves the live set and lands in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      deleteLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(url).toContain("deleted_recoverable");

    expect(await liabilityIds(store)).not.toContain("card");
    expect(await trashedLiabilityIds(store)).toContain("card");

    store.close();
  });

  test("an unknown id reports not-found without touching the live set", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      deleteLiabilityAction,
      form({ id: "ghost" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await liabilityIds(store)).toContain("card");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedHoldings();
    mockPersonaCookie = "familia";

    const url = await runAction(
      deleteLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await liabilityIds(store)).toContain("card");
    expect(await trashedLiabilityIds(store)).toHaveLength(0);

    store.close();
  });
});

describe("hardDeleteAssetAction", () => {
  test("permanently removes a trashed asset — gone from both live and trash", async () => {
    const store = await seedHoldings();
    await store.assets.softDeleteAsset("cash", TODAY);
    expect(await trashedAssetIds(store)).toContain("cash");

    const url = await runAction(
      hardDeleteAssetAction,
      form({ id: "cash" }),
      store,
      CLOCK,
    );
    expect(url).toContain("hard_deleted");

    expect(await assetIds(store)).not.toContain("cash");
    expect(await trashedAssetIds(store)).not.toContain("cash");

    store.close();
  });

  test("refuses an asset that is not in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      hardDeleteAssetAction,
      form({ id: "cash" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await assetIds(store)).toContain("cash");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the trash untouched", async () => {
    const store = await seedHoldings();
    await store.assets.softDeleteAsset("cash", TODAY);
    mockPersonaCookie = "familia";

    const url = await runAction(
      hardDeleteAssetAction,
      form({ id: "cash" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await trashedAssetIds(store)).toContain("cash");

    store.close();
  });
});

describe("hardDeleteLiabilityAction", () => {
  test("permanently removes a trashed liability — gone from both live and trash", async () => {
    const store = await seedHoldings();
    await store.liabilities.softDeleteLiability("card", TODAY);
    expect(await trashedLiabilityIds(store)).toContain("card");

    const url = await runAction(
      hardDeleteLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(url).toContain("hard_deleted");

    expect(await liabilityIds(store)).not.toContain("card");
    expect(await trashedLiabilityIds(store)).not.toContain("card");

    store.close();
  });

  test("refuses a liability that is not in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      hardDeleteLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await liabilityIds(store)).toContain("card");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the trash untouched", async () => {
    const store = await seedHoldings();
    await store.liabilities.softDeleteLiability("card", TODAY);
    mockPersonaCookie = "familia";

    const url = await runAction(
      hardDeleteLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await trashedLiabilityIds(store)).toContain("card");

    store.close();
  });
});

describe("restoreAssetAction", () => {
  test("restores a trashed asset back to the live set", async () => {
    const store = await seedHoldings();
    await store.assets.softDeleteAsset("cash", TODAY);
    expect(await assetIds(store)).not.toContain("cash");

    const url = await runAction(restoreAssetAction, form({ id: "cash" }), store, CLOCK);
    expect(url).toContain("restored");

    expect(await assetIds(store)).toContain("cash");
    expect(await trashedAssetIds(store)).not.toContain("cash");

    store.close();
  });

  test("refuses an asset that is not in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(restoreAssetAction, form({ id: "cash" }), store, CLOCK);
    expect(url).toContain("error=");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the trash untouched", async () => {
    const store = await seedHoldings();
    await store.assets.softDeleteAsset("cash", TODAY);
    mockPersonaCookie = "familia";

    const url = await runAction(restoreAssetAction, form({ id: "cash" }), store, CLOCK);
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await assetIds(store)).not.toContain("cash");
    expect(await trashedAssetIds(store)).toContain("cash");

    store.close();
  });
});

describe("restoreLiabilityAction", () => {
  test("restores a trashed liability back to the live set", async () => {
    const store = await seedHoldings();
    await store.liabilities.softDeleteLiability("card", TODAY);
    expect(await liabilityIds(store)).not.toContain("card");

    const url = await runAction(
      restoreLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(url).toContain("restored");

    expect(await liabilityIds(store)).toContain("card");
    expect(await trashedLiabilityIds(store)).not.toContain("card");

    store.close();
  });

  test("refuses a liability that is not in the trash", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      restoreLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the trash untouched", async () => {
    const store = await seedHoldings();
    await store.liabilities.softDeleteLiability("card", TODAY);
    mockPersonaCookie = "familia";

    const url = await runAction(
      restoreLiabilityAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await liabilityIds(store)).not.toContain("card");
    expect(await trashedLiabilityIds(store)).toContain("card");

    store.close();
  });
});

describe("emptyTrashAction", () => {
  test("hard-deletes everything in the trash, leaving the live set intact", async () => {
    const store = await seedHoldings();
    // Trash the liability, keep the asset live.
    await store.liabilities.softDeleteLiability("card", TODAY);
    expect(await trashedLiabilityIds(store)).toContain("card");

    const url = await runAction(emptyTrashAction, form({}), store, CLOCK);
    expect(url).toContain("trash_emptied");

    expect(await trashedLiabilityIds(store)).toHaveLength(0);
    expect(await trashedAssetIds(store)).toHaveLength(0);
    // The live asset was never in the trash, so it survives.
    expect(await assetIds(store)).toContain("cash");

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the trash untouched", async () => {
    const store = await seedHoldings();
    await store.liabilities.softDeleteLiability("card", TODAY);
    mockPersonaCookie = "familia";

    const url = await runAction(emptyTrashAction, form({}), store, CLOCK);
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await trashedLiabilityIds(store)).toContain("card");

    store.close();
  });
});

describe("acknowledgeWarningAction", () => {
  async function overrides(store: WorthlineStore) {
    return store.readWarningOverrides();
  }

  test("records the override for the (code, entityId) pair", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      acknowledgeWarningAction,
      form({ code: "MISSING_PRICE", entityId: "cash" }),
      store,
      CLOCK,
    );
    expect(url).toContain("warning_acknowledged");

    expect(await overrides(store)).toContainEqual({
      code: "MISSING_PRICE",
      entityId: "cash",
    });

    store.close();
  });

  test("a missing code reports an error without recording anything", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      acknowledgeWarningAction,
      form({ entityId: "cash" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await overrides(store)).toHaveLength(0);

    store.close();
  });

  test("a missing entityId reports an error without recording anything", async () => {
    const store = await seedHoldings();

    const url = await runAction(
      acknowledgeWarningAction,
      form({ code: "MISSING_PRICE" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await overrides(store)).toHaveLength(0);

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedHoldings();
    mockPersonaCookie = "familia";

    const url = await runAction(
      acknowledgeWarningAction,
      form({ code: "MISSING_PRICE", entityId: "cash" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await overrides(store)).toHaveLength(0);

    store.close();
  });
});
