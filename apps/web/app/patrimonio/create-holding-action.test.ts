/**
 * Action-level tests for the unified createHoldingAction (issue #151, PRD #146 S5).
 *
 * The action is the public seam of the instrument-first add flow: given a form
 * carrying the chosen `instrument` plus that instrument's suffixed fields, it
 * derives the holding's defaults from the catalog (defaultsFor) and persists a
 * correct holding — a manual asset, an investment, or a liability — reading ONLY
 * the selected instrument's fields (the others POST as hidden inputs and are
 * ignored). These tests assert the resulting store state + the success redirect.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { defaultInstrumentForLiability } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createHoldingAction } from "./create-holding-action";

/** Build a FormData with the given key/value pairs. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke the action (which always throws redirect()) and return the URL. */
async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await createHoldingAction(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function seedStore(): WorthlineStore {
  const store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

describe("createHoldingAction — stored assets", () => {
  test("current_account → manual asset on the cash rung, instrument persisted", async () => {
    const store = seedStore();

    const url = await runAction(
      form({
        instrument: "current_account",
        name_current_account: "Cuenta BBVA",
        value_current_account: "2.500,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("/patrimonio");
    expect(url).toContain("ok=");

    const assets = store.assets.readAssets();
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    expect(asset.name).toBe("Cuenta BBVA");
    expect(asset.type).toBe("cash");
    expect(asset.liquidityTier).toBe("cash");
    expect(asset.instrument).toBe("current_account");
    expect(asset.currentValue.amountMinor).toBe(250_000);
  });

  test("vehicle → manual asset on the illiquid rung, instrument persisted", async () => {
    const store = seedStore();

    await runAction(
      form({
        instrument: "vehicle",
        name_vehicle: "Renault Clio",
        value_vehicle: "8.500,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const asset = store.assets.readAssets()[0]!;
    expect(asset.type).toBe("manual");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.instrument).toBe("vehicle");
    expect(asset.currentValue.amountMinor).toBe(850_000);
  });

  test("ignores the hidden fields of the non-selected instruments", async () => {
    const store = seedStore();

    // Both current_account and vehicle fields POST; only current_account is chosen.
    await runAction(
      form({
        instrument: "current_account",
        name_current_account: "Cuenta BBVA",
        value_current_account: "2.500,00",
        name_vehicle: "Coche que no debe crearse",
        value_vehicle: "99.999,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const assets = store.assets.readAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe("Cuenta BBVA");
    expect(assets[0]!.instrument).toBe("current_account");
  });
});

describe("createHoldingAction — appreciating (property)", () => {
  test("property → real_estate on illiquid, with acquisition anchor + instrument", async () => {
    const store = seedStore();

    const url = await runAction(
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

    expect(url).toContain("ok=");

    const asset = store.assets.readAssets()[0]!;
    expect(asset.type).toBe("real_estate");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.instrument).toBe("property");
    expect(asset.currentValue.amountMinor).toBe(18_000_000);

    // The acquisition seeds a valuation anchor (the curve's base).
    const anchors = store.assets.readValuationAnchors(asset.id);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    expect(anchors.some((a) => a.valuationDate === "2020-01-15")).toBe(true);
  });
});

describe("createHoldingAction — derived investments", () => {
  test("stock → investment with instrument=stock and the yahoo provider", async () => {
    const store = seedStore();

    const url = await runAction(
      form({
        instrument: "stock",
        name_stock: "Apple",
        symbol_stock: "AAPL",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=");

    const meta = store.assets.readInvestmentAssetsWithMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.priceProvider).toBe("yahoo");
    expect(meta[0]!.providerSymbol).toBe("AAPL");

    // The chosen instrument is persisted distinctly — not collapsed to "fund".
    const asset = store.assets.readAssets().find((a) => a.id === meta[0]!.id);
    expect(asset?.instrument).toBe("stock");
    expect(asset?.liquidityTier).toBe("market");
  });

  test("crypto → investment with instrument=crypto and the coingecko provider", async () => {
    const store = seedStore();

    await runAction(
      form({
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "BTC-EUR",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = store.assets.readInvestmentAssetsWithMeta()[0]!;
    expect(meta.priceProvider).toBe("coingecko");

    const asset = store.assets.readAssets().find((a) => a.id === meta.id);
    expect(asset?.instrument).toBe("crypto");
  });

  test("pension_plan → investment with instrument=pension_plan and finect provider", async () => {
    const store = seedStore();

    await runAction(
      form({
        instrument: "pension_plan",
        name_pension_plan: "Indexa",
        symbol_pension_plan: "N5394",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = store.assets.readInvestmentAssetsWithMeta()[0]!;
    expect(meta.priceProvider).toBe("finect");

    const asset = store.assets.readAssets().find((a) => a.id === meta.id);
    expect(asset?.instrument).toBe("pension_plan");
    expect(asset?.liquidityTier).toBe("term-locked");
  });
});

describe("createHoldingAction — debts", () => {
  test("mortgage → mortgage liability with the amortizable model", async () => {
    const store = seedStore();

    const url = await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca Santander",
        balance_mortgage: "120.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=");

    const liability = store.liabilities.readLiabilities()[0]!;
    expect(liability.type).toBe("mortgage");
    expect(liability.currentBalance.amountMinor).toBe(12_000_000);
    expect(store.liabilities.readDebtModel(liability.id)).toBe("amortizable");
    // The instrument is recoverable from (type, debtModel).
    expect(defaultInstrumentForLiability("mortgage", "amortizable")).toBe("mortgage");
  });

  test("loan → debt liability with the amortizable model (derives to loan)", async () => {
    const store = seedStore();

    await runAction(
      form({
        instrument: "loan",
        name_loan: "Préstamo coche",
        balance_loan: "8.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = store.liabilities.readLiabilities()[0]!;
    expect(liability.type).toBe("debt");
    expect(store.liabilities.readDebtModel(liability.id)).toBe("amortizable");
    expect(defaultInstrumentForLiability("debt", "amortizable")).toBe("loan");
  });

  test("credit_card → debt liability with the revolving model (derives to credit_card)", async () => {
    const store = seedStore();

    await runAction(
      form({
        instrument: "credit_card",
        name_credit_card: "Visa BBVA",
        balance_credit_card: "850,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = store.liabilities.readLiabilities()[0]!;
    expect(liability.type).toBe("debt");
    expect(store.liabilities.readDebtModel(liability.id)).toBe("revolving");
    expect(defaultInstrumentForLiability("debt", "revolving")).toBe("credit_card");
  });
});
