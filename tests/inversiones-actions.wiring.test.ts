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

vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

import { updateInvestmentAction } from "@web/inversiones/update-investment-action";
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

  // #1743: la v70 le escribe al plan su código DGS, y la ficha —que solo sabe
  // enseñar un ISIN— no puede tirarlo por el hecho de guardar. Es la regresión que
  // dejaría al holding «sin clasificar» en cuanto #1744 re-clave el catálogo.
  test("guardar la ficha de un plan NO borra su código DGS", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: INVESTMENT_ID,
      instrument: "pension_plan",
      liquidityTier: "term-locked",
      name: "MyInvestor Indexado S&P 500",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      securityId: { kind: "dgs", value: "N5394" },
    });

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd({ isin: "", name: "MyInvestor Indexado S&P 500" }, "/inversiones"),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(
      (await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.securityId,
    ).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("un ISIN en blanco sí borra el ISIN que había", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: INVESTMENT_ID,
      liquidityTier: "market",
      name: "Index Fund",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      securityId: { kind: "isin", value: "IE00B03HCZ61" },
    });

    await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd({ isin: "", name: "Index Fund" }, "/inversiones"),
        store,
      ),
    );

    expect(
      (await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.securityId,
    ).toBeUndefined();
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

  test("a symbol Yahoo can quote validates through the seam (ok=saved)", async () => {
    // Validation routes through fetchPriceNow (ADR 0026); a quoted symbol saves.
    // It used to be allowed to ride a Yahoo→Stooq rescue, retired in #1354.
    await setupStoreWithInvestment();
    stubYahooQuote("4.25");

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as Response));

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

// ===================================== the value-only opening guard (#1329) ==

/**
 * A holding born «por valor total» (#1325): its ENTIRE position is one
 * participación priced at the whole declared value. Handing it a symbol makes
 * the quote govern the valuation, so 574,48 € silently become one share.
 */
async function setupValueOnlyHolding(): Promise<void> {
  await setupStoreWithInvestment();
  await store.command.recordInvestmentOperation(
    {
      assetId: INVESTMENT_ID,
      currency: "EUR",
      executedAt: "2026-07-28",
      feesMinor: 0,
      id: "op_opening",
      kind: "buy",
      pricePerUnit: "574.48",
      source: "opening",
      units: "1",
    },
    { today: "2026-07-28" },
  );
}

/**
 * Stub the pricing seam with a Yahoo quote at `close`. The as-of timestamp is
 * NOW because the provider rejects a market date older than a week (#730) and
 * these actions read the real clock.
 */
function stubYahooQuote(close: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { currency: "EUR" },
              timestamp: [Math.floor(Date.now() / 1000)],
              indicators: { quote: [{ close: [Number(close)] }] },
            },
          ],
        },
      }),
    } as unknown as Response),
  );
}

describe("updateInvestmentAction · value-only opening guard (#1329)", () => {
  test("assigning a symbol over the 1-participación alta is blocked, with both figures", async () => {
    await setupValueOnlyHolding();
    stubYahooQuote("11.90");

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          { name: "Index Fund", priceProvider: "yahoo", providerSymbol: "SAN.MC" },
          "/inversiones",
        ),
        store,
      ),
    );

    // Query-encoded spaces («+») and Intl's non-breaking ones both flatten here.
    const message = decodeURIComponent(url).replace(/[+\s]/g, " ");
    expect(url).toContain("error=");
    expect(message).toContain("574,48 €");
    expect(message).toContain("11,90 €");
    expect(
      (await store.assets.readInvestmentAssetById(INVESTMENT_ID))?.providerSymbol,
    ).toBeUndefined();
  });

  test("the acknowledgement («es una participación real») lets the save through", async () => {
    await setupValueOnlyHolding();
    stubYahooQuote("11.90");

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund",
            priceProvider: "yahoo",
            providerSymbol: "SAN.MC",
            valueOnlySymbolAck: "on",
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

  test("a real ledger (units derived from a price) is never blocked", async () => {
    await setupStoreWithInvestment();
    await store.command.recordInvestmentOperation(
      {
        assetId: INVESTMENT_ID,
        currency: "EUR",
        executedAt: "2026-07-28",
        feesMinor: 0,
        id: "op_opening",
        kind: "buy",
        pricePerUnit: "11.90",
        source: "opening",
        units: "48.275630",
      },
      { today: "2026-07-28" },
    );
    stubYahooQuote("11.90");

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          { name: "Index Fund", priceProvider: "yahoo", providerSymbol: "SAN.MC" },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
  });

  test("editing a holding that ALREADY has the symbol is not the guard's business", async () => {
    await setupValueOnlyHolding();
    await store.assets.updateInvestmentAsset({
      id: INVESTMENT_ID,
      liquidityTier: "market",
      name: "Index Fund",
      priceProvider: "yahoo",
      providerSymbol: "SAN.MC",
    });
    stubYahooQuote("11.90");

    const url = await catchRedirect(() =>
      updateInvestmentAction(
        INVESTMENT_ID,
        fd(
          {
            name: "Index Fund Renamed",
            priceProvider: "yahoo",
            providerSymbol: "SAN.MC",
          },
          "/inversiones",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
  });
});
