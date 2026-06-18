/**
 * Wiring suite: inversiones server actions
 * (createInvestmentAction, updateInvestmentAction,
 *  deleteInvestmentAction, restoreInvestmentAction).
 *
 * recordOperationAction is covered by operation-bounds-invariant.wiring.test.ts.
 * refreshPricesAction depends on an external network provider and is excluded
 * from this isolated suite.
 *
 * FormData in → redirect-or-error out, real in-memory store.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  updateInvestmentAction,
  deleteInvestmentAction,
  restoreInvestmentAction,
} from "../apps/web/app/inversiones/actions";
import { catchRedirect, fd } from "./helpers";

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

const MEMBER_ID = "member_yo";
const INVESTMENT_ID = "asset_fund_001";

afterEach(() => {
  store?.close();
  vi.unstubAllGlobals();
});

function setupStore() {
  store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  return store;
}

function setupStoreWithInvestment() {
  setupStore();
  store.assets.createInvestmentAsset({
    id: INVESTMENT_ID,
    name: "Index Fund",
    currency: "EUR",
    liquidityTier: "market",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  return store;
}

// =========================================================== createInvestmentAction

// ========================================================== updateInvestmentAction

describe("updateInvestmentAction wiring", () => {
  test("happy path: name updated", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd({
          currentUrl: `/inversiones/${INVESTMENT_ID}/editar`,
          name: "MSCI World Renamed",
        }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    const asset = store.assets.readInvestmentAssetById(INVESTMENT_ID);
    expect(asset?.name).toBe("MSCI World Renamed");
  });

  test("happy path: ticker symbol updated", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund",
            unitSymbol: "VWRL.UK",
          },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    const asset = store.assets.readInvestmentAssetById(INVESTMENT_ID);
    expect(asset?.unitSymbol).toBe("VWRL.UK");
  });

  test("changing provider symbol clears the old cached price", async () => {
    setupStoreWithInvestment();
    store.assets.updateInvestmentAsset({
      id: INVESTMENT_ID,
      name: "Index Fund",
      liquidityTier: "market",
      priceProvider: "yahoo",
      providerSymbol: "OLD.MC",
    });
    store.operations.upsertPrice({
      assetId: INVESTMENT_ID,
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
      price: "12.34",
      source: "yahoo",
    });

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund",
            priceProvider: "finect",
            providerSymbol: "N5394",
          },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(store.assets.readInvestmentAssetById(INVESTMENT_ID)?.providerSymbol).toBe(
      "N5394",
    );
    expect(store.operations.readPriceCache(INVESTMENT_ID)).toBeNull();
  });

  test("blank name: error redirect, asset unchanged", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      updateInvestmentAction(INVESTMENT_ID, fd({ name: "" }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/nombre/i);
    expect(store.assets.readInvestmentAssetById(INVESTMENT_ID)?.name).toBe("Index Fund");
  });

  test("invalid manual price: error redirect", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd({ name: "Index Fund", manualPricePerUnit: "abc" }, "/inversiones"),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/precio/i);
  });

  test("Yahoo miss rescued by Stooq: symbol validates through the seam (ok=saved)", async () => {
    // Validation routes through fetchPriceNow now (ADR 0026), so it gains the
    // Yahoo→Stooq fallback for free: a transient Yahoo miss no longer rejects a
    // symbol Stooq can still price. Under the old Yahoo-only validation this
    // would have error-redirected.
    setupStoreWithInvestment();
    const stooqOk =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false } as Response)
        .mockResolvedValueOnce({ ok: true, text: async () => stooqOk } as Response),
    );

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund",
            priceProvider: "yahoo",
            providerSymbol: "SAN.MC",
          },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(store.assets.readInvestmentAssetById(INVESTMENT_ID)?.providerSymbol).toBe(
      "SAN.MC",
    );
  });

  test("invalid Yahoo provider symbol: error redirect, asset unchanged", async () => {
    setupStoreWithInvestment();
    const stooqNoData =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nBAD,N/D,N/D,N/D,N/D,N/D,N/D,0";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false } as Response)
        .mockResolvedValueOnce({ ok: true, text: async () => stooqNoData } as Response),
    );

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund Renamed",
            priceProvider: "yahoo",
            providerSymbol: "BAD.MC",
          },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/símbolo/i);
    expect(store.assets.readInvestmentAssetById(INVESTMENT_ID)?.name).toBe("Index Fund");
  });
});

// ========================================================== deleteInvestmentAction

describe("deleteInvestmentAction wiring", () => {
  test("happy path: investment soft-deleted, redirect to deleted_recoverable", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      deleteInvestmentAction(fd({ id: INVESTMENT_ID }, "/inversiones"), store),
    );

    expect(url).toContain("ok=deleted_recoverable");
    const trash = store.readTrash();
    expect(trash.assets.some((a) => a.id === INVESTMENT_ID)).toBe(true);
  });

  test("missing id: error redirect", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      deleteInvestmentAction(fd({ id: "" }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("unknown id (changes=0): error redirect", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      deleteInvestmentAction(fd({ id: "asset_nonexistent" }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/eliminado/i);
  });
});

// ========================================================= restoreInvestmentAction

describe("restoreInvestmentAction wiring", () => {
  test("happy path: soft-deleted investment is restored", async () => {
    setupStoreWithInvestment();
    store.assets.softDeleteAsset(INVESTMENT_ID, new Date().toISOString());

    const url = await catchRedirect(() =>
      restoreInvestmentAction(fd({ id: INVESTMENT_ID }, "/inversiones"), store),
    );

    expect(url).toContain("ok=restored");
    expect(store.assets.readInvestmentAssetsWithMeta()).toHaveLength(1);
    expect(store.readTrash().assets).toHaveLength(0);
  });

  test("missing id: error redirect", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      restoreInvestmentAction(fd({ id: "" }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
  });

  test("investment not in trash (changes=0): error redirect", async () => {
    setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      restoreInvestmentAction(fd({ id: INVESTMENT_ID }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/papelera/i);
  });
});
