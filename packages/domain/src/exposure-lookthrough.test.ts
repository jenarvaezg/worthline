import { describe, expect, test } from "vitest";

import { calculateNetWorth, createManualAsset, createWorkspace } from "./index";
import {
  createExposureProfile,
  lookThroughExposure,
  type ExposureProfile,
} from "./exposure-lookthrough";

describe("lookThroughExposure", () => {
  test("value-weights seeded single-region and multi-region profiles", () => {
    const profiles = new Map<string, ExposureProfile>([
      [
        "IE00SP500",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            currency: { USD: "1" },
            geography: { us: "1" },
          },
          hedged: false,
          key: "IE00SP500",
        }),
      ],
      [
        "IE00WORLD",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            currency: { EUR: "0.2", JPY: "0.1", USD: "0.7" },
            geography: {
              europe_developed: "0.2",
              japan: "0.1",
              us: "0.7",
            },
          },
          hedged: false,
          key: "IE00WORLD",
        }),
      ],
    ]);

    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 300_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_sp500",
          instrument: "etf",
          isin: "IE00SP500",
          valueMinor: 100_000,
        },
        {
          currency: "EUR",
          id: "asset_world",
          instrument: "fund",
          isin: "IE00WORLD",
          valueMinor: 200_000,
        },
      ],
      profiles,
    });

    expect(result.geography.slices).toEqual([
      { key: "us", value: { amountMinor: 240_000, currency: "EUR" }, weight: "0.8" },
      {
        key: "europe_developed",
        value: { amountMinor: 40_000, currency: "EUR" },
        weight: "0.1333",
      },
      {
        key: "japan",
        value: { amountMinor: 20_000, currency: "EUR" },
        weight: "0.0667",
      },
    ]);
    expect(result.currency.slices).toEqual([
      { key: "USD", value: { amountMinor: 240_000, currency: "EUR" }, weight: "0.8" },
      { key: "EUR", value: { amountMinor: 40_000, currency: "EUR" }, weight: "0.1333" },
      { key: "JPY", value: { amountMinor: 20_000, currency: "EUR" }, weight: "0.0667" },
    ]);
    expect(result.assetClass.slices).toEqual([
      {
        key: "equity",
        value: { amountMinor: 300_000, currency: "EUR" },
        weight: "1",
      },
    ]);
    expect(result.geography.coverage).toEqual({
      classified: { amountMinor: 300_000, currency: "EUR" },
      notApplicable: { amountMinor: 0, currency: "EUR" },
      unknown: { amountMinor: 0, currency: "EUR" },
    });
  });

  test("auto-derived cash crypto and commodity holdings are not geography gaps", () => {
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 100_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_cash",
          instrument: "current_account",
          valueMinor: 10_000,
        },
        {
          currency: "EUR",
          id: "asset_crypto",
          instrument: "crypto",
          valueMinor: 20_000,
        },
        {
          currency: "EUR",
          id: "asset_gold",
          instrument: "precious_metal",
          valueMinor: 30_000,
        },
        {
          currency: "EUR",
          id: "asset_unprofiled_fund",
          instrument: "fund",
          isin: "IE00MISSING",
          valueMinor: 40_000,
        },
      ],
      profiles: new Map(),
    });

    expect(result.geography.coverage).toEqual({
      classified: { amountMinor: 0, currency: "EUR" },
      notApplicable: { amountMinor: 60_000, currency: "EUR" },
      unknown: { amountMinor: 40_000, currency: "EUR" },
    });
    expect(result.assetClass.slices).toEqual([
      {
        key: "commodity",
        value: { amountMinor: 30_000, currency: "EUR" },
        weight: "0.3",
      },
      {
        key: "crypto",
        value: { amountMinor: 20_000, currency: "EUR" },
        weight: "0.2",
      },
      { key: "cash", value: { amountMinor: 10_000, currency: "EUR" }, weight: "0.1" },
    ]);
    expect(result.assetClass.coverage).toEqual({
      classified: { amountMinor: 60_000, currency: "EUR" },
      notApplicable: { amountMinor: 0, currency: "EUR" },
      unknown: { amountMinor: 40_000, currency: "EUR" },
    });
  });

  test("rejects a profile breakdown above 100 percent", () => {
    expect(() =>
      createExposureProfile({
        breakdowns: {
          geography: { emerging: "0.25", us: "0.8" },
        },
        key: "bad_profile",
      }),
    ).toThrow("Exposure profile geography breakdown cannot exceed 100%.");
  });

  test("resolves a pension-plan profile by provider symbol when ISIN is absent", () => {
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 90_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_plan",
          instrument: "pension_plan",
          providerSymbol: "N5394",
          valueMinor: 90_000,
        },
      ],
      profiles: new Map([
        [
          "N5394",
          createExposureProfile({
            breakdowns: {
              assetClass: { equity: "1" },
              currency: { USD: "1" },
              geography: { us: "1" },
            },
            key: "N5394",
          }),
        ],
      ]),
    });

    expect(result.geography.slices).toEqual([
      { key: "us", value: { amountMinor: 90_000, currency: "EUR" }, weight: "1" },
    ]);
  });

  test("keeps an under-100 percent breakdown remainder as other", () => {
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 100_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_partial",
          instrument: "etf",
          isin: "PARTIAL",
          valueMinor: 100_000,
        },
      ],
      profiles: new Map([
        [
          "PARTIAL",
          createExposureProfile({
            breakdowns: {
              assetClass: { equity: "1" },
              currency: { USD: "0.75" },
              geography: { us: "0.7" },
            },
            key: "PARTIAL",
          }),
        ],
      ]),
    });

    expect(result.geography.slices).toEqual([
      { key: "us", value: { amountMinor: 70_000, currency: "EUR" }, weight: "0.7" },
      {
        key: "other",
        value: { amountMinor: 30_000, currency: "EUR" },
        weight: "0.3",
      },
    ]);
    expect(result.currency.slices).toEqual([
      { key: "USD", value: { amountMinor: 75_000, currency: "EUR" }, weight: "0.75" },
      {
        key: "other",
        value: { amountMinor: 25_000, currency: "EUR" },
        weight: "0.25",
      },
    ]);
  });

  test("allocates tiny breakdowns without exceeding the holding value", () => {
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 1, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_tiny",
          instrument: "etf",
          isin: "TINY",
          valueMinor: 1,
        },
      ],
      profiles: new Map([
        [
          "TINY",
          createExposureProfile({
            breakdowns: {
              assetClass: { bond: "0.5", equity: "0.5" },
              currency: { JPY: "0.5", USD: "0.5" },
              geography: { emerging: "0.5", us: "0.5" },
            },
            key: "TINY",
          }),
        ],
      ]),
    });

    expect(
      result.geography.slices.reduce((sum, slice) => sum + slice.value.amountMinor, 0),
    ).toBe(1);
    expect(
      result.currencyRisk.reduce((sum, slice) => sum + slice.value.amountMinor, 0),
    ).toBe(1);
  });

  test("currency risk includes unhedged non-base currency exposure and excludes hedged holdings", () => {
    const profiles = new Map<string, ExposureProfile>([
      [
        "UNHEDGED",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            currency: { USD: "1" },
            geography: { us: "1" },
          },
          hedged: false,
          key: "UNHEDGED",
        }),
      ],
      [
        "HEDGED",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            currency: { USD: "1" },
            geography: { us: "1" },
          },
          hedged: true,
          key: "HEDGED",
        }),
      ],
    ]);

    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 300_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_unhedged",
          instrument: "etf",
          isin: "UNHEDGED",
          valueMinor: 100_000,
        },
        {
          currency: "EUR",
          id: "asset_hedged",
          instrument: "etf",
          isin: "HEDGED",
          valueMinor: 200_000,
        },
      ],
      profiles,
    });

    expect(result.currencyRisk).toEqual([
      {
        key: "USD",
        value: { amountMinor: 100_000, currency: "EUR" },
        weight: "0.3333",
      },
    ]);
  });

  test("row provenance does not affect look-through allocation", () => {
    const profiles = new Map<string, ExposureProfile>([
      [
        "AGENT",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            geography: { us: "1" },
          },
          declaredAt: "2026-02-01T00:00:00.000Z",
          key: "AGENT",
          source: "agent",
        }),
      ],
    ]);

    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 100_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_agent",
          instrument: "etf",
          isin: "AGENT",
          valueMinor: 100_000,
        },
      ],
      profiles,
    });

    expect(result.geography.slices).toEqual([
      { key: "us", value: { amountMinor: 100_000, currency: "EUR" }, weight: "1" },
    ]);
  });

  test("can restrict geography to equity exposure", () => {
    const profiles = new Map<string, ExposureProfile>([
      [
        "EQUITY",
        createExposureProfile({
          breakdowns: {
            assetClass: { equity: "1" },
            currency: { USD: "1" },
            geography: { us: "1" },
          },
          key: "EQUITY",
        }),
      ],
      [
        "BOND",
        createExposureProfile({
          breakdowns: {
            assetClass: { bond: "1" },
            currency: { EUR: "1" },
            geography: { europe_developed: "1" },
          },
          key: "BOND",
        }),
      ],
    ]);

    const result = lookThroughExposure({
      assetClassFilter: "equity",
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 300_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_equity",
          instrument: "fund",
          isin: "EQUITY",
          valueMinor: 100_000,
        },
        {
          currency: "EUR",
          id: "asset_bond",
          instrument: "fund",
          isin: "BOND",
          valueMinor: 100_000,
        },
        {
          currency: "EUR",
          id: "asset_cash",
          instrument: "current_account",
          valueMinor: 100_000,
        },
      ],
      profiles,
    });

    expect(result.geography.slices).toEqual([
      { key: "us", value: { amountMinor: 100_000, currency: "EUR" }, weight: "1" },
    ]);
    expect(result.geography.coverage).toEqual({
      classified: { amountMinor: 100_000, currency: "EUR" },
      notApplicable: { amountMinor: 0, currency: "EUR" },
      unknown: { amountMinor: 0, currency: "EUR" },
    });
  });

  test("asset-class filtering reports only the filtered class", () => {
    const result = lookThroughExposure({
      assetClassFilter: "equity",
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 100_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_mixed",
          instrument: "fund",
          isin: "MIXED",
          valueMinor: 100_000,
        },
      ],
      profiles: new Map([
        [
          "MIXED",
          createExposureProfile({
            breakdowns: {
              assetClass: { bond: "0.4", equity: "0.6" },
              currency: { USD: "1" },
              geography: { us: "1" },
            },
            key: "MIXED",
          }),
        ],
      ]),
    });

    expect(result.assetClass.slices).toEqual([
      { key: "equity", value: { amountMinor: 60_000, currency: "EUR" }, weight: "1" },
    ]);
  });

  test("auto-derives property exposure from the holding location", () => {
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: { amountMinor: 250_000, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          geography: "europe_developed",
          id: "asset_home",
          instrument: "property",
          valueMinor: 250_000,
        },
      ],
      profiles: new Map(),
    });

    expect(result.assetClass.slices).toEqual([
      {
        key: "property",
        value: { amountMinor: 250_000, currency: "EUR" },
        weight: "1",
      },
    ]);
    expect(result.geography.slices).toEqual([
      {
        key: "europe_developed",
        value: { amountMinor: 250_000, currency: "EUR" },
        weight: "1",
      },
    ]);
    expect(result.currency.slices).toEqual([
      { key: "EUR", value: { amountMinor: 250_000, currency: "EUR" }, weight: "1" },
    ]);
  });

  test("does not change net-worth math", () => {
    const workspace = createWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const asset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_fund",
      instrument: "fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    });
    const before = calculateNetWorth({
      assets: [asset],
      liabilities: [],
      scopeId: "household",
      workspace,
    });

    lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets: before.grossAssets,
      holdings: [
        {
          currency: asset.currency,
          id: asset.id,
          instrument: "fund",
          isin: "IE00SP500",
          valueMinor: asset.currentValue.amountMinor,
        },
      ],
      profiles: new Map([
        [
          "IE00SP500",
          createExposureProfile({
            breakdowns: {
              assetClass: { equity: "1" },
              currency: { USD: "1" },
              geography: { us: "1" },
            },
            key: "IE00SP500",
          }),
        ],
      ]),
    });

    expect(
      calculateNetWorth({
        assets: [asset],
        liabilities: [],
        scopeId: "household",
        workspace,
      }),
    ).toEqual(before);
  });
});
