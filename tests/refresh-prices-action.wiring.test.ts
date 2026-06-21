import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import type { PriceProvider } from "@worthline/pricing";
import { refreshPricesAction } from "@web/inversiones/actions";
import { catchRedirect, fd } from "./helpers";

let store: WorthlineStore;

const MEMBER_ID = "member_yo";

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

function mockProvider(results: Record<string, { price: string } | null>): PriceProvider {
  return {
    name: "stooq",
    fetchPrice: vi.fn().mockImplementation(async (ctx: { symbol: string }) => {
      const result = results[ctx.symbol];
      if (!result) return null;
      return { price: result.price, currency: "EUR" };
    }),
  };
}

function throwingProvider(): PriceProvider {
  return {
    name: "stooq",
    fetchPrice: vi.fn().mockRejectedValue(new Error("network down")),
  };
}

describe("refreshPricesAction wiring", () => {
  test("success: fresh price cached and redirect reports updated=1", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_1",
      name: "Test ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "TEST.WA",
    });

    const provider = mockProvider({ "TEST.WA": { price: "42.50" } });

    const url = await catchRedirect(() =>
      refreshPricesAction(fd({}, "/inversiones"), store, provider),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=1");
    expect(url).not.toContain("failed=");

    const cached = await store.operations.readPriceCache("asset_1");
    expect(cached).not.toBeNull();
    expect(cached!.price).toBe("42.50");
    expect(cached!.freshnessState).toBe("fresh");
  });

  test("partial failure: one fresh, one null → updated=1 and failed=FAIL.WA", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_ok",
      name: "Good ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "GOOD.WA",
    });
    await store.assets.createInvestmentAsset({
      id: "asset_bad",
      name: "Bad ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "FAIL.WA",
    });

    const provider = mockProvider({
      "GOOD.WA": { price: "10.00" },
      "FAIL.WA": null,
    });

    const url = await catchRedirect(() =>
      refreshPricesAction(fd({}, "/inversiones"), store, provider),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=1");
    expect(url).toContain("failed=FAIL.WA");
  });

  test("total failure (provider throws): updated=0, failed symbol listed, no throw", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_err",
      name: "Broken ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "BROKEN.WA",
    });

    const provider = throwingProvider();

    const url = await catchRedirect(() =>
      refreshPricesAction(fd({}, "/inversiones"), store, provider),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=0");
    expect(url).toContain("failed=BROKEN.WA");
  });

  test("no refreshable assets: updated=0, no failed param", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_no_sym",
      name: "Manual Fund",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });

    const provider = mockProvider({});

    const url = await catchRedirect(() =>
      refreshPricesAction(fd({}, "/inversiones"), store, provider),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=0");
    expect(url).not.toContain("failed=");
  });

  test("assetId scopes the refresh to a single holding (#406)", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_target",
      name: "Target ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "TARGET.WA",
    });
    await store.assets.createInvestmentAsset({
      id: "asset_other",
      name: "Other ETF",
      currency: "EUR",
      liquidityTier: "market",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "OTHER.WA",
    });

    const provider = mockProvider({
      "TARGET.WA": { price: "11.00" },
      "OTHER.WA": { price: "22.00" },
    });

    const url = await catchRedirect(() =>
      refreshPricesAction(
        fd({ assetId: "asset_target" }, "/patrimonio/asset_target/editar"),
        store,
        provider,
      ),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=1");
    // Only the targeted holding is refetched + cached; the sibling is untouched.
    expect(provider.fetchPrice).toHaveBeenCalledTimes(1);
    expect(await store.operations.readPriceCache("asset_target")).not.toBeNull();
    expect(await store.operations.readPriceCache("asset_other")).toBeNull();
  });

  test("real routing path refreshes retirement investments through Finect", async () => {
    await setupStore();
    await store.assets.createInvestmentAsset({
      id: "asset_pension",
      name: "Pension Plan",
      currency: "EUR",
      liquidityTier: "term-locked",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      providerSymbol: "N5394",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <p>Valor liquidativo</p>
          <strong>20,63 €</strong>
          <span>Fecha de valor liquidativo: 10/06/2026</span>
        `,
      } as Response),
    );

    const url = await catchRedirect(() =>
      refreshPricesAction(fd({}, "/inversiones"), store),
    );

    expect(url).toContain("ok=prices_refreshed");
    expect(url).toContain("updated=1");
    expect(await store.operations.readPriceCache("asset_pension")).toMatchObject({
      price: "20.63",
      source: "finect",
    });
  });
});
