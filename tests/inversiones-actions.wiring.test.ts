/**
 * Wiring suite: inversiones server actions
 * (createInvestmentAction, updateInvestmentAction).
 *
 * recordOperationAction is covered by operation-bounds-invariant.wiring.test.ts.
 * refreshPricesAction depends on an external network provider and is excluded
 * from this isolated suite.
 *
 * FormData in → redirect-or-error out, real in-memory store.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateInvestmentAction } from "@web/inversiones/actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect, fd } from "./helpers";

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

const MEMBER_ID = "member_yo";
const INVESTMENT_ID = "asset_fund_001";

afterEach(() => {
  store?.close();
  vi.unstubAllGlobals();
});

async function setupStore() {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  return store;
}

async function setupStoreWithInvestment() {
  await setupStore();
  await store.assets.createInvestmentAsset({
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
    await setupStoreWithInvestment();

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
    const asset = await store.assets.readInvestmentAssetById(INVESTMENT_ID);
    expect(asset?.name).toBe("MSCI World Renamed");
  });

  test("happy path: ticker symbol updated", async () => {
    await setupStoreWithInvestment();

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
    const asset = await store.assets.readInvestmentAssetById(INVESTMENT_ID);
    expect(asset?.unitSymbol).toBe("VWRL.UK");
  });

  test("changing provider symbol clears the old cached price", async () => {
    await setupStoreWithInvestment();
    await store.assets.updateInvestmentAsset({
      id: INVESTMENT_ID,
      name: "Index Fund",
      liquidityTier: "market",
      priceProvider: "yahoo",
      providerSymbol: "OLD.MC",
    });
    await store.operations.upsertPrice({
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
    expect(
      (await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.providerSymbol,
    ).toBe("N5394");
    expect(await store.operations.readPriceCache(INVESTMENT_ID)).toBeNull();
  });

  test("blank name: error redirect, asset unchanged", async () => {
    await setupStoreWithInvestment();

    const url = await catchRedirect(() =>
      updateInvestmentAction(INVESTMENT_ID, fd({ name: "" }, "/inversiones"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/nombre/i);
    expect((await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.name).toBe(
      "Index Fund",
    );
  });

  test("invalid manual price: error redirect", async () => {
    await setupStoreWithInvestment();

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
    await setupStoreWithInvestment();
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
    expect(
      (await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.providerSymbol,
    ).toBe("SAN.MC");
  });

  test("invalid Yahoo provider symbol: error redirect, asset unchanged", async () => {
    await setupStoreWithInvestment();
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
    expect((await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.name).toBe(
      "Index Fund",
    );
  });
});
