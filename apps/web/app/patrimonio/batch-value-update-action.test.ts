/**
 * Action-level tests for batchValueUpdateAction — the manual value-update pass
 * ("puesta al día") (#308).
 *
 * The pass hand-updates the value of every holding whose valuation method is NOT
 * derived (ADR 0014): cash/manual (`stored`) and properties (`appreciating`,
 * whose current value anchors the curve) are eligible; investments and other
 * derived-value holdings (connected-source coin collections) are computed from
 * their sub-detail and must stay excluded. These tests PIN that exact set so the
 * catalog-seam refactor (#308) — dropping the inline derived-id deny-list —
 * preserves behaviour byte-for-byte.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { batchValueUpdateAction } from "./actions";
import { createHoldingAction } from "./create-holding-action";

/** Build a FormData with the given key/value pairs. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke an action (which always redirect()s) and return the redirect URL/digest. */
async function runAction(
  action: (fd: FormData, store: WorthlineStore) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seedStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/**
 * Seed one holding of each valuation method that matters here and return its id:
 *  - a current account  → `stored`       (hand-valued, eligible)
 *  - a property         → `appreciating` (hand-valued, eligible)
 *  - a stock investment → `derived`      (computed from operations, excluded)
 */
async function seedHoldings(store: WorthlineStore): Promise<{
  storedId: string;
  appreciatingId: string;
  derivedId: string;
}> {
  await runAction(
    createHoldingAction,
    form({
      instrument: "current_account",
      name_current_account: "Cuenta BBVA",
      value_current_account: "2.500,00",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );
  await runAction(
    createHoldingAction,
    form({
      instrument: "property",
      name_property: "Piso Malasaña",
      acqDate_property: "2020-01-15",
      acqValue_property: "180.000,00",
      rate_property: "3",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );
  await runAction(
    createHoldingAction,
    form({
      instrument: "stock",
      name_stock: "Apple",
      symbol_stock: "AAPL",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
    }),
    store,
  );

  const assets = await store.assets.readAssets();
  const storedId = assets.find((a) => a.instrument === "current_account")!.id;
  const appreciatingId = assets.find((a) => a.instrument === "property")!.id;
  const derivedId = assets.find((a) => a.instrument === "stock")!.id;
  return { storedId, appreciatingId, derivedId };
}

describe("batchValueUpdateAction — who the value-update pass accepts (#308)", () => {
  test("hand-valued holdings (stored + appreciating) are updated", async () => {
    const store = await seedStore();
    const { storedId, appreciatingId } = await seedHoldings(store);

    const url = await runAction(
      batchValueUpdateAction,
      form({
        [`val_${storedId}`]: "3.000,00",
        [`val_${appreciatingId}`]: "200.000,00",
      }),
      store,
    );

    // No error redirect — the submission was accepted.
    expect(url).not.toContain("error=");
    expect(url).toContain("/patrimonio");

    const assets = await store.assets.readAssets();
    expect(assets.find((a) => a.id === storedId)!.currentValue.amountMinor).toBe(300_000);
    expect(assets.find((a) => a.id === appreciatingId)!.currentValue.amountMinor).toBe(
      20_000_000,
    );
  });

  test("a derived holding (investment) is rejected — value comes from its sub-detail", async () => {
    const store = await seedStore();
    const { derivedId } = await seedHoldings(store);

    const url = await runAction(
      batchValueUpdateAction,
      form({ [`val_${derivedId}`]: "9.999,00" }),
      store,
    );

    // The pass refuses a derived holding rather than hand-setting its value.
    expect(url).toContain("error=");
  });
});
