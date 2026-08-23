import { describe, expect, test } from "vitest";
import type { SourcePosition } from "./connected-source";
import {
  type CollectDataQualitySignalsInput,
  collectDataQualitySignals,
  compareDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  type DataQualitySignal,
  type DataQualitySyncAttempt,
  PERSISTENT_SYNC_FAILURE_CODE,
} from "./data-quality-signals";
import type { FireScopeConfig } from "./fire";
import type { InvestmentOperation } from "./investment-types";
import { formatMoneyMinor } from "./money";
import { netUnitsByAsset } from "./positions";
import { listScopeOptions, type ScopeOption } from "./scope";
import {
  type CreateManualAssetInput,
  createLiability,
  createManualAsset,
  createWorkspace,
  type Workspace,
} from "./workspace-types";

function owner() {
  return [{ memberId: "member_jose", shareBps: 10_000 }];
}

function baseInput(
  workspace: Workspace,
  scopeOption: ScopeOption,
  overrides: Partial<CollectDataQualitySignalsInput> = {},
): CollectDataQualitySignalsInput {
  return {
    asOfDateKey: "2026-07-11",
    assetCreatedAtById: new Map(),
    assets: [],
    amortizableStartByLiabilityId: new Map(),
    connectedSources: [],
    debtModelByLiabilityId: new Map(),
    fireConfigByScopeId: {},
    investmentOperationsByAssetId: new Map(),
    liabilities: [],
    manualValueHistoryByAssetId: new Map(),
    netUnitsByAssetId: new Map(),
    positionsBySourceId: new Map(),
    priceFreshnessByAssetId: new Map(),
    scope: {
      internalScopeId: scopeOption.id,
      scopeLabel: scopeOption.label,
    },
    scopeOption,
    snapshotIdsWithHoldings: new Set(),
    snapshotHoldings: [],
    snapshots: [],
    sourceFreshnessBySourceId: new Map(),
    syncAttemptsBySourceId: new Map(),
    trashedHoldings: [],
    warningOverrides: [],
    workspace,
    ...overrides,
  };
}

function fixture() {
  const workspace = createWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const scopeOption = listScopeOptions(workspace)[0]!;
  return {
    asset: (
      partial: Pick<CreateManualAssetInput, "id" | "name"> &
        Partial<CreateManualAssetInput>,
    ) =>
      createManualAsset(workspace, {
        ...partial,
        currency: partial.currency ?? "EUR",
        currentValueMinor: partial.currentValueMinor ?? 1_000_00,
        liquidityTier: partial.liquidityTier ?? "market",
        ownership: partial.ownership ?? owner(),
        type: partial.type ?? "manual",
      }),
    input: (overrides: Partial<CollectDataQualitySignalsInput> = {}) =>
      baseInput(workspace, scopeOption, overrides),
    scopeOption,
    workspace,
  };
}

function tokenPosition(externalId: string, name: string): SourcePosition {
  return {
    balance: "100",
    currency: "EUR",
    externalId,
    id: `pos_${externalId}`,
    kind: "token",
    liquidityTier: "market",
    name,
    sourceId: "src_binance",
    symbol: name,
    unitPrice: null,
    wallet: "spot",
    imageUrl: null,
  };
}

/** A coin of a Numista collection: base metal, graded, and unvalued by default (no
 *  melt value, no estimate, no purchase price) — each test overrides the one input
 *  it is about. */
function coinPosition(
  externalId: string,
  overrides: Partial<Extract<SourcePosition, { kind: "coin" }>> = {},
): SourcePosition {
  return {
    catalogueId: "1493",
    currency: "EUR",
    externalId,
    finenessMillis: null,
    grade: "XF",
    id: `pos_${externalId}`,
    issueId: 42,
    kind: "coin",
    liquidityTier: "illiquid",
    metal: null,
    metalValueMinor: null,
    name: `Moneda ${externalId}`,
    numismaticFetchedAt: null,
    numismaticValueMinor: null,
    obverseThumbUrl: null,
    purchaseDate: null,
    purchasePriceMinor: null,
    quantity: 1,
    sourceId: "src_numista",
    weightGrams: null,
    year: 2020,
    ...overrides,
  };
}

function seededInput() {
  const { asset, input } = fixture();
  return input({
    assetCreatedAtById: new Map([["asset_stale_cash", "2025-01-01T00:00:00.000Z"]]),
    assets: [
      asset({
        currentValueMinor: 0,
        id: "asset_zero",
        liquidityTier: "illiquid",
        name: "Cuadro sin tasar",
      }),
      asset({
        currentValueMinor: 2_500_00,
        id: "asset_stale_cash",
        name: "Cuenta olvidada",
        type: "cash",
      }),
      asset({
        currentValueMinor: 5_000_00,
        id: "asset_stale",
        name: "Fondo viejo",
      }),
      asset({
        currentValueMinor: 3_000_00,
        id: "asset_failed",
        name: "Fondo roto",
      }),
    ],
    connectedSources: [
      {
        assetIds: ["asset_stale"],
        id: "src_binance",
        label: "Binance",
        lastSyncAt: "2026-06-16T10:00:00.000Z",
      },
    ],
    debtModelByLiabilityId: new Map([["liab_mortgage", null]]),
    liabilities: [
      {
        associatedAssetId: "asset_home",
        currency: "EUR",
        currentBalance: { amountMinor: 100_000_00, currency: "EUR" },
        id: "liab_mortgage",
        name: "Hipoteca",
        ownership: owner(),
        type: "mortgage",
      },
    ],
    positionsBySourceId: new Map([["src_binance", [tokenPosition("SHIB:spot", "SHIB")]]]),
    priceFreshnessByAssetId: new Map([
      [
        "asset_stale",
        {
          fetchedAt: "2026-01-01T00:00:00.000Z",
          freshnessState: "stale",
        },
      ],
      [
        "asset_failed",
        {
          fetchedAt: "2026-02-01T00:00:00.000Z",
          freshnessState: "failed",
        },
      ],
    ]),
    sourceFreshnessBySourceId: new Map([
      [
        "src_binance",
        {
          fetchedAt: "2026-06-17T09:00:00.000Z",
          freshnessState: "stale",
        },
      ],
    ]),
  });
}

describe("collectDataQualitySignals", () => {
  test("surfaces warning, price, source, config, history, and projection-gap categories", () => {
    const signals = collectDataQualitySignals(seededInput());

    expect(new Set(signals.map((signal) => signal.category))).toEqual(
      new Set([
        "warning",
        "manual_value_freshness",
        "price_freshness",
        "source_freshness",
        "missing_configuration",
        "history_coverage",
        "projection_gap",
      ]),
    );
  });

  test("labels overridden warnings without suppressing them", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        assets: [
          asset({
            currentValueMinor: 0,
            id: "asset_zero",
            liquidityTier: "illiquid",
            name: "Cuadro sin tasar",
          }),
        ],
        warningOverrides: [{ code: "ZERO_VALUE_ASSET", entityId: "asset_zero" }],
      }),
    );

    const warningSignals = signals.filter((signal) => signal.category === "warning");

    expect(warningSignals).toHaveLength(1);
    expect(warningSignals[0]!.code).toBe("ZERO_VALUE_ASSET");
    expect(warningSignals[0]!.label).toContain("marcado como intencional");
    expect(warningSignals[0]!.affected).toEqual({
      id: "asset_zero",
      label: "Cuadro sin tasar",
      object: "holding",
    });
  });

  test("an oversell on the ledger is a medium warning, silenced by override", () => {
    const { asset, input } = fixture();
    const operationsByAssetId = new Map([
      [
        "inv_jorge",
        [
          {
            assetId: "inv_jorge",
            currency: "EUR" as const,
            executedAt: "2026-01-01",
            feesMinor: 0,
            id: "buy",
            kind: "buy" as const,
            pricePerUnit: "10",
            units: "31.999",
          },
          {
            assetId: "inv_jorge",
            currency: "EUR" as const,
            executedAt: "2026-02-01",
            feesMinor: 0,
            id: "sell",
            kind: "sell" as const,
            pricePerUnit: "10",
            units: "32",
          },
        ],
      ],
    ]);
    const holding = asset({
      id: "inv_jorge",
      instrument: "etf",
      name: "Amundi Europe",
      providerSymbol: "AE.PA",
      type: "investment",
    });

    const signals = collectDataQualitySignals(
      input({
        assets: [holding],
        investmentOperationsByAssetId: operationsByAssetId,
        netUnitsByAssetId: new Map([["inv_jorge", "0"]]),
      }),
    );
    const oversell = signals.filter((signal) => signal.code === "OVERSELL");

    expect(oversell).toHaveLength(1);
    expect(oversell[0]).toMatchObject({
      category: "warning",
      severity: "medium",
    });

    const labelled = collectDataQualitySignals(
      input({
        assets: [holding],
        investmentOperationsByAssetId: operationsByAssetId,
        netUnitsByAssetId: new Map([["inv_jorge", "0"]]),
        warningOverrides: [{ code: "OVERSELL", entityId: "inv_jorge" }],
      }),
    ).find((signal) => signal.code === "OVERSELL");

    expect(labelled?.label).toContain("marcado como intencional");
  });

  test("orders by severity desc, then category, then affected id, then natural key", () => {
    const signals = collectDataQualitySignals(seededInput()).sort(
      compareDataQualitySignals,
    );

    const severityRank = { high: 0, medium: 1, low: 2 } as const;
    // Read off the engine's own order rather than mirrored here: a hand-kept copy
    // still passes when a category is inserted (every rank shifts equally), so it
    // would silently stop testing the thing it names.
    const categoryRank: Record<string, number> = Object.fromEntries(
      DATA_QUALITY_CATEGORY_ORDER.map((category, rank) => [category, rank]),
    );

    const keyOf = (signal: DataQualitySignal) =>
      [
        severityRank[signal.severity],
        categoryRank[signal.category],
        signal.affected?.id ?? "",
        signal.naturalKey,
      ] as const;

    for (let index = 1; index < signals.length; index += 1) {
      expect(keyOf(signals[index - 1]!) <= keyOf(signals[index]!)).toBe(true);
    }
  });

  test("flags stored holdings whose last manual update is at or past the 90-day threshold", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-07-11",
        assetCreatedAtById: new Map([["asset_cash", "2025-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
      }),
    );

    const stale = signals.filter(
      (signal) => signal.category === "manual_value_freshness",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.code).toBe("STALE_MANUAL_VALUE");
    expect(stale[0]!.observedDate).toBe("2025-01-01");
    expect(stale[0]!.severity).toBe("medium");
    expect(stale[0]!.fixable).toBe(true);
  });

  test("does not flag stored holdings updated within the threshold", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-07-11",
        assetCreatedAtById: new Map([["asset_cash", "2025-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
        manualValueHistoryByAssetId: new Map([
          ["asset_cash", [{ dateKey: "2026-04-13", valueMinor: 1_000_00 }]],
        ]),
      }),
    );

    expect(signals.some((signal) => signal.code === "STALE_MANUAL_VALUE")).toBe(false);
  });

  test("uses the latest manual value date instead of creation when history exists", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-07-11",
        assetCreatedAtById: new Map([["asset_cash", "2020-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
        manualValueHistoryByAssetId: new Map([
          [
            "asset_cash",
            [
              { dateKey: "2026-01-01", valueMinor: 900_00 },
              { dateKey: "2026-04-13", valueMinor: 1_000_00 },
            ],
          ],
        ]),
      }),
    );

    expect(signals.some((signal) => signal.code === "STALE_MANUAL_VALUE")).toBe(false);
  });

  test("labels overridden stale-manual signals without removing them", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-07-11",
        assetCreatedAtById: new Map([["asset_cash", "2025-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
        warningOverrides: [{ code: "STALE_MANUAL_VALUE", entityId: "asset_cash" }],
      }),
    );

    const stale = signals.filter(
      (signal) => signal.category === "manual_value_freshness",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.label).toContain("marcado como intencional");
  });

  test("flags exactly at the 90-day threshold", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-04-01",
        assetCreatedAtById: new Map([["asset_cash", "2026-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
      }),
    );

    expect(signals.some((signal) => signal.code === "STALE_MANUAL_VALUE")).toBe(true);
  });

  test("does not flag one day inside the threshold", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-03-31",
        assetCreatedAtById: new Map([["asset_cash", "2026-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 1_000_00,
            id: "asset_cash",
            name: "Cuenta corriente",
            type: "cash",
          }),
        ],
      }),
    );

    expect(signals.some((signal) => signal.code === "STALE_MANUAL_VALUE")).toBe(false);
  });

  test("skips derived holdings for stale-manual detection", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        asOfDateKey: "2026-07-11",
        assetCreatedAtById: new Map([["asset_fund", "2020-01-01T00:00:00.000Z"]]),
        assets: [
          asset({
            currentValueMinor: 0,
            id: "asset_fund",
            instrument: "fund",
            name: "Fondo",
            type: "investment",
          }),
        ],
      }),
    );

    expect(signals.some((signal) => signal.code === "STALE_MANUAL_VALUE")).toBe(false);
  });
});

describe("collectDataQualitySignals — UNVALUED_POSITION aggregated per source (#1356)", () => {
  const collection = (positions: SourcePosition[]) => {
    const { asset, input } = fixture();
    return collectDataQualitySignals(
      input({
        assets: [
          asset({ id: "asset_coins", liquidityTier: "illiquid", name: "Monedas" }),
        ],
        connectedSources: [
          {
            assetIds: ["asset_coins"],
            id: "src_numista",
            label: "Colección Numista",
            lastSyncAt: "2026-07-11T10:00:00.000Z",
          },
        ],
        positionsBySourceId: new Map([["src_numista", positions]]),
      }),
    ).filter((signal) => signal.category === "projection_gap");
  };

  test("a collection with many unvalued coins raises ONE signal, not one per coin", () => {
    const signals = collection([
      coinPosition("1", { grade: "" }),
      coinPosition("2", { grade: "" }),
      coinPosition("3", { metal: "silver", weightGrams: 31.1 }),
      coinPosition("4", { metalValueMinor: 4_000 }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.code).toBe("UNVALUED_POSITION");
    // The source, not the position, is the identity — so the key is stable while
    // coins come and go from the collection.
    expect(signals[0]!.naturalKey).toBe("projection_gap:UNVALUED_POSITION:src_numista");
    expect(signals[0]!.affected).toEqual({
      id: "src_numista",
      label: "Colección Numista",
      object: "connected_source",
    });
  });

  test("the label counts the unvalued coins against the whole collection and says what is missing", () => {
    const signals = collection([
      coinPosition("1", { grade: "" }),
      coinPosition("2", { grade: "" }),
      coinPosition("3", { metal: "silver", weightGrams: 31.1 }),
      coinPosition("4", { metalValueMinor: 4_000 }),
    ]);

    expect(signals[0]!.label).toBe(
      '3 de 4 monedas de "Colección Numista" sin valor, a 0 € en tu patrimonio.' +
        " Lo que falta: 2 sin grado en Numista, 1 sin la ley del metal en el catálogo.",
    );
  });

  test("a fully valued collection raises nothing", () => {
    expect(collection([coinPosition("1", { metalValueMinor: 4_000 })])).toEqual([]);
  });

  test("counts coins, not lines: a ×N line stands for N coins", () => {
    // What the catalogue view shows as "5 monedas" must not read as "2" here.
    const signals = collection([
      coinPosition("1", { grade: "", quantity: 3 }),
      coinPosition("2", { metalValueMinor: 4_000, quantity: 2 }),
    ]);

    expect(signals[0]!.label).toBe(
      '3 de 5 monedas de "Colección Numista" sin valor, a 0 € en tu patrimonio.' +
        " Lo que falta: 3 sin grado en Numista.",
    );
  });

  test("unpriced tokens aggregate the same way, in their own words", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        assets: [asset({ id: "asset_crypto", name: "Cripto" })],
        connectedSources: [
          {
            assetIds: ["asset_crypto"],
            id: "src_binance",
            label: "Binance",
            lastSyncAt: "2026-07-11T10:00:00.000Z",
          },
        ],
        positionsBySourceId: new Map([
          [
            "src_binance",
            [
              tokenPosition("SHIB:spot", "SHIB"),
              tokenPosition("LUNA:spot", "LUNA"),
              { ...tokenPosition("BTC:spot", "BTC"), unitPrice: "90000" },
            ],
          ],
        ]),
      }),
    ).filter((signal) => signal.category === "projection_gap");

    expect(signals).toHaveLength(1);
    // No "what's missing" breakdown: an unpriced token has exactly one cause.
    expect(signals[0]!.label).toBe(
      '2 de 3 tokens de "Binance" sin fuente de precio, a 0 € en tu patrimonio.',
    );
  });

  test("the noun follows the count, so a one-position source reads in singular", () => {
    expect(collection([coinPosition("1", { grade: "" })])[0]!.label).toBe(
      '1 de 1 moneda de "Colección Numista" sin valor, a 0 € en tu patrimonio.' +
        " Lo que falta: 1 sin grado en Numista.",
    );
  });

  test("a mixed source reads generically and drops the breakdown that would only cover half", () => {
    // No adapter mirrors both kinds today, but a breakdown that explained the
    // coins while the count also carried tokens would not add up.
    const signals = collection([
      coinPosition("1", { grade: "" }),
      { ...tokenPosition("SHIB:spot", "SHIB"), sourceId: "src_numista" },
    ]);

    expect(signals[0]!.label).toBe(
      '2 de 2 posiciones de "Colección Numista" sin valor, a 0 € en tu patrimonio.',
    );
  });
});

describe("collectDataQualitySignals — MISSING_PROVIDER_SYMBOL on closed positions (#1348)", () => {
  const symbollessFund = (asset: ReturnType<typeof fixture>["asset"]) =>
    asset({
      currentValueMinor: 0,
      id: "asset_sold_fund",
      instrument: "fund",
      name: "Fondo vendido entero",
      type: "investment",
    });

  const codesFor = (netUnits: [string, string][] | undefined) => {
    const { asset, input } = fixture();
    return collectDataQualitySignals(
      input({
        assets: [symbollessFund(asset)],
        ...(netUnits ? { netUnitsByAssetId: new Map(netUnits) } : {}),
      }),
    )
      .filter((signal) => signal.category === "warning")
      .map((signal) => signal.code);
  };

  test("a sold-out fund no longer regenerates the signal every day", () => {
    expect(codesFor([["asset_sold_fund", "0"]])).toEqual([]);
  });

  test("an open symbol-less fund still surfaces it as actionable", () => {
    expect(codesFor([["asset_sold_fund", "42.7"]])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });

  test("a fund with no operation yet is unstarted, not closed — the task stands", () => {
    expect(codesFor(undefined)).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });
});

describe("collectDataQualitySignals — price freshness on closed positions (#1348)", () => {
  // The symbol'd sibling of the case above: this fund HAS a provider symbol, so
  // it never raised MISSING_PROVIDER_SYMBOL — but its cached price keeps going
  // stale/failing forever after the position is sold out, and FAILED_PRICE is
  // `high`, which turns the home hero red over a figure of 0.
  const priceCodesFor = (netUnits: [string, string][] | undefined) => {
    const { asset, input } = fixture();
    return collectDataQualitySignals(
      input({
        assets: [
          asset({
            currentValueMinor: 0,
            id: "asset_sold_etf",
            instrument: "etf",
            name: "ETF vendido entero",
            providerSymbol: "SOLD.MI",
            type: "investment",
          }),
        ],
        ...(netUnits ? { netUnitsByAssetId: new Map(netUnits) } : {}),
        priceFreshnessByAssetId: new Map([
          [
            "asset_sold_etf",
            { fetchedAt: "2026-02-01T00:00:00.000Z", freshnessState: "failed" as const },
          ],
        ]),
      }),
    )
      .filter((signal) => signal.category === "price_freshness")
      .map((signal) => signal.code);
  };

  test("a sold-out position stops reporting a failed price it does not need", () => {
    expect(priceCodesFor([["asset_sold_etf", "0"]])).toEqual([]);
  });

  test("the same position still open reports the failed price", () => {
    expect(priceCodesFor([["asset_sold_etf", "8"]])).toEqual(["FAILED_PRICE"]);
  });

  test("a holding with no ledger read keeps today's behaviour", () => {
    expect(priceCodesFor(undefined)).toEqual(["FAILED_PRICE"]);
  });

  test("a stale price on a stored holding is untouched by net units", () => {
    const { asset, input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        assets: [
          asset({ currentValueMinor: 1_000_00, id: "asset_cash", name: "Cuenta" }),
        ],
        // A non-derived holding is never in the map, so it can never read closed.
        netUnitsByAssetId: new Map([["asset_cash", "0"]]),
        priceFreshnessByAssetId: new Map([
          [
            "asset_cash",
            { fetchedAt: "2026-01-01T00:00:00.000Z", freshnessState: "stale" as const },
          ],
        ]),
      }),
    );

    expect(signals.filter((s) => s.code === "STALE_PRICE")).toHaveLength(1);
  });
});

/**
 * A holding trashed with units still on its ledger (#1365). The real case: four
 * fondos sent to the Papelera the same day, three at zero units (harmless) and one
 * with a four-figure value — the next day's patrimonio fell by that amount, and
 * 82 % of the daily drop was the delete, not the market.
 */
describe("collectDataQualitySignals — TRASHED_WITH_BALANCE (#1365)", () => {
  const trashedWithNetUnits = (
    netUnitsByAssetId: ReadonlyMap<string, string>,
    ownerMemberIds: readonly string[] = ["member_jose"],
  ) => {
    const { input } = fixture();
    return collectDataQualitySignals(
      input({
        netUnitsByAssetId,
        trashedHoldings: [{ id: "asset_fondo", name: "Fondo Indexado", ownerMemberIds }],
      }),
    ).filter((signal) => signal.category === "trashed_balance");
  };
  const trashed = (
    netUnits: Array<[string, string]>,
    ownerMemberIds: readonly string[] = ["member_jose"],
  ) => trashedWithNetUnits(new Map(netUnits), ownerMemberIds);

  test("a trashed holding with live units raises a high-severity signal naming them", () => {
    const signals = trashed([["asset_fondo", "120.5"]]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.code).toBe("TRASHED_WITH_BALANCE");
    expect(signals[0]!.severity).toBe("high");
    expect(signals[0]!.fixable).toBe(true);
    expect(signals[0]!.naturalKey).toBe(
      "trashed_balance:TRASHED_WITH_BALANCE:asset_fondo",
    );
    expect(signals[0]!.affected).toEqual({
      id: "asset_fondo",
      label: "Fondo Indexado",
      object: "holding",
    });
    // The units read in es-ES, and the label names BOTH repairs the trash listing
    // already offers — restore and record the sale, or confirm the borrado.
    expect(signals[0]!.label).toContain("120,5 unidades");
    expect(signals[0]!.label).toContain("sin venta ni traspaso");
    expect(signals[0]!.label).toContain("registra la venta");
  });

  test("a trashed holding sold out first is silent — the clean delete stays clean", () => {
    expect(trashed([["asset_fondo", "0"]])).toEqual([]);
    expect(trashed([["asset_fondo", "0.00001"]])).toEqual([]);
  });

  test("«fue un error de registro» calla la señal: la pregunta ya está respondida (#1549)", () => {
    const { input } = fixture();
    const withExit = (trashExit: "sold" | "mis_entry" | null) =>
      collectDataQualitySignals(
        input({
          netUnitsByAssetId: new Map([["asset_fondo", "120.5"]]),
          trashedHoldings: [
            {
              id: "asset_fondo",
              name: "Fondo Indexado",
              ownerMemberIds: ["member_jose"],
              trashExit,
            },
          ],
        }),
      ).filter((signal) => signal.category === "trashed_balance");

    expect(withExit("mis_entry")).toEqual([]);
    // Solo esa declaración. «Lo vendí» sobre un libro que sigue con unidades no es
    // una salida: es una venta que nadie registró, que es justo lo que la señal caza.
    expect(withExit("sold")).toHaveLength(1);
    expect(withExit(null)).toHaveLength(1);
  });

  test("a trashed holding with no ledger at all is silent, not flagged on a rule it cannot answer", () => {
    // A trashed cash account or flat has no operations, so it is absent from the
    // map. Absent must not read as "has units" — that would flag every trashed
    // holding in the workspace.
    expect(trashed([])).toEqual([]);
  });

  test("the signal is scoped by ownership, since no live read can see the trash", () => {
    expect(trashed([["asset_fondo", "120.5"]], ["member_otro"])).toEqual([]);
    expect(trashed([["asset_fondo", "120.5"]], [])).toEqual([]);
  });

  // #1481: «se fue sin venta ni traspaso» por fin es literal. Un origen liquidado
  // por transfer_out folda a cero unidades netas — salida legítima, señal muda —
  // mientras que el mismo libro sin operación de salida sigue disparando. Se
  // encadena netUnitsByAsset con un libro real, no un neto escrito a mano, porque
  // lo que se fija es la cadena entera: fold → neto → señal.
  test("un origen liquidado por traspaso es una salida legítima: la señal calla", () => {
    const ledger = (operations: InvestmentOperation[]) =>
      trashedWithNetUnits(netUnitsByAsset(new Map([["asset_fondo", operations]])));
    const buy: InvestmentOperation = {
      assetId: "asset_fondo",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    };
    const transferOut: InvestmentOperation = {
      assetId: "asset_fondo",
      currency: "EUR",
      executedAt: "2026-08-12",
      feesMinor: 0,
      id: "op_out",
      kind: "transfer_out",
      pricePerUnit: "150",
      transferId: "trf_1",
      units: "10",
    };

    expect(ledger([buy, transferOut])).toEqual([]);
    expect(ledger([buy])).toHaveLength(1);
  });
});

/**
 * Una conexión cuyo sync falla intento tras intento (#1226, PRD #1222 S4).
 *
 * Lo que estas pruebas fijan es el UMBRAL, que es la decisión del slice: un fallo
 * suelto no alerta a nadie (la página de conexiones ya lo cuenta), dos seguidos sí,
 * y un `ok` posterior cierra la racha aunque la cola de intentos siga llena de
 * fallos viejos.
 */
describe("collectDataQualitySignals — PERSISTENT_SYNC_FAILURE (#1226)", () => {
  const attempt = (
    status: DataQualitySyncAttempt["status"],
    at: string | null = "2026-08-16T09:00:00.000Z",
  ): DataQualitySyncAttempt => ({ at, status });

  /** Newest-first, como las entrega el puerto de lectura. */
  const syncSignals = (
    attempts: DataQualitySyncAttempt[],
    freshnessState?: "fresh" | "stale" | "failed",
  ) => {
    const { asset, input } = fixture();
    return collectDataQualitySignals(
      input({
        assets: [asset({ id: "asset_binance", name: "Binance (spot)" })],
        connectedSources: [
          {
            assetIds: ["asset_binance"],
            id: "src_binance",
            label: "Binance",
            lastSyncAt: "2026-08-10T10:00:00.000Z",
          },
        ],
        ...(freshnessState === undefined
          ? {}
          : {
              sourceFreshnessBySourceId: new Map([
                [
                  "src_binance",
                  { fetchedAt: "2026-08-17T09:00:00.000Z", freshnessState },
                ],
              ]),
            }),
        syncAttemptsBySourceId: new Map([["src_binance", attempts]]),
      }),
    ).filter((signal) => signal.code === PERSISTENT_SYNC_FAILURE_CODE);
  };

  test("dos intentos seguidos con error alertan, fechados en el más reciente", () => {
    const signals = syncSignals([
      attempt("error", "2026-08-17T09:00:00.000Z"),
      attempt("error", "2026-08-16T21:00:00.000Z"),
      attempt("ok", "2026-08-16T09:00:00.000Z"),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.category).toBe("source_freshness");
    expect(signals[0]!.severity).toBe("high");
    // El guardado es nuestro, no un dato que el usuario pueda corregir.
    expect(signals[0]!.fixable).toBe(false);
    expect(signals[0]!.naturalKey).toBe(
      "source_freshness:PERSISTENT_SYNC_FAILURE:src_binance",
    );
    expect(signals[0]!.affected).toEqual({
      id: "src_binance",
      label: "Binance",
      object: "connected_source",
    });
    // La frase dice CUÁNTAS, no «falla mucho», y no manda hacer nada imposible.
    expect(signals[0]!.label).toBe(
      'Las últimas 2 sincronizaciones de "Binance" fallaron: sus cifras siguen ' +
        "congeladas en la última que funcionó.",
    );
    expect(signals[0]!.observedDate).toBe("2026-08-17");
  });

  test("un fallo puntual no alerta: la página ya lo cuenta sin dar la lata", () => {
    expect(syncSignals([attempt("error"), attempt("ok")])).toEqual([]);
    expect(syncSignals([attempt("error")])).toEqual([]);
  });

  test("un sync bueno cierra la racha, por muchos fallos viejos que queden detrás", () => {
    expect(
      syncSignals([attempt("ok"), attempt("error"), attempt("error"), attempt("error")]),
    ).toEqual([]);
  });

  test("un reintento en vuelo no borra el veredicto de lo anterior", () => {
    // Si `running` cortase la racha, la alerta desaparecería justo mientras se
    // reintenta y volvería al fallar: parpadeo en vez de señal.
    const signals = syncSignals([
      attempt("running", null),
      attempt("pending", null),
      attempt("error", "2026-08-17T09:00:00.000Z"),
      attempt("error", "2026-08-16T21:00:00.000Z"),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.observedDate).toBe("2026-08-17");
  });

  test("la racha entera va en la frase, no solo el umbral", () => {
    const signals = syncSignals([
      attempt("error"),
      attempt("error"),
      attempt("error"),
      attempt("error"),
    ]);

    expect(signals[0]!.label).toContain("Las últimas 4 sincronizaciones");
  });

  test("una fuente sin intentos, o con ninguno terminal, está callada", () => {
    expect(syncSignals([])).toEqual([]);
    expect(syncSignals([attempt("running", null), attempt("pending", null)])).toEqual([]);
  });

  test("un fallo sin instante alerta igual, pero sin fecha inventada", () => {
    const signals = syncSignals([attempt("error", null), attempt("error", null)]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.observedDate).toBeUndefined();
  });

  test("cede ante un fetch roto AHORA: una avería, una línea roja", () => {
    // El fetch roto es la causa viva y `FAILED_SOURCE_SYNC` ya es `high` y apunta al
    // mismo sitio; dos rojos sobre la misma conexión ocuparían dos de los tres
    // huecos del bloque para una sola cosa que hacer.
    const failing = [attempt("error"), attempt("error")];

    expect(syncSignals(failing, "failed")).toEqual([]);
    // Un fetch meramente rancio no la calla: son dos lecturas distintas y esta manda
    // por severidad.
    expect(syncSignals(failing, "stale")).toHaveLength(1);
    expect(syncSignals(failing, "fresh")).toHaveLength(1);
  });

  test("un fallo reciente sin instante no cede la fecha a uno más viejo", () => {
    // La fila más reciente puede llegar sin fechar (una corrida abierta que nunca
    // llegó a `running`). Heredar la fecha del fallo anterior diría «falló el día
    // que aún funcionaba».
    const signals = syncSignals([
      attempt("error", null),
      attempt("error", "2026-08-16T21:00:00.000Z"),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.observedDate).toBeUndefined();
  });

  test("una fuente cuyos activos no son del ámbito no alerta en ese ámbito", () => {
    const { input } = fixture();
    const signals = collectDataQualitySignals(
      input({
        // Sin el activo espejo entre los holdings del ámbito, la fuente no es suya.
        assets: [],
        connectedSources: [
          {
            assetIds: ["asset_ajeno"],
            id: "src_binance",
            label: "Binance",
            lastSyncAt: null,
          },
        ],
        syncAttemptsBySourceId: new Map([
          ["src_binance", [attempt("error"), attempt("error")]],
        ]),
      }),
    );

    expect(signals.filter((s) => s.code === PERSISTENT_SYNC_FAILURE_CODE)).toEqual([]);
  });
});

describe("collectDataQualitySignals — SAVINGS_DECLARED_VS_MEASURED (#1449)", () => {
  /** One 100 €/month buy for the 12 months ending 2026-07 (the fixture's asOf). */
  function monthlyBuys(assetId: string, amountMajor: number): InvestmentOperation[] {
    const months = [
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ];
    return months.map((month) => ({
      assetId,
      currency: "EUR",
      executedAt: `${month}-10`,
      feesMinor: 0,
      id: `buy-${month}`,
      kind: "buy",
      pricePerUnit: "1",
      units: String(amountMajor),
    }));
  }

  function collect(
    fireConfig: FireScopeConfig | undefined,
    operations: InvestmentOperation[],
    /** Book the ledger under a holding the scope does not own. */
    ledgerHoldingId = "asset_fondo",
  ) {
    const { asset, input, scopeOption, workspace } = fixture();
    const fondo = asset({
      currentValueMinor: 50_000_00,
      id: "asset_fondo",
      name: "Fondo indexado",
      providerSymbol: "IWDA.AS",
      type: "investment",
    });

    return collectDataQualitySignals(
      input({
        assets: [fondo],
        fireConfigByScopeId:
          fireConfig === undefined ? {} : { [scopeOption.id]: fireConfig },
        investmentOperationsByAssetId: new Map([[ledgerHoldingId, operations]]),
        netUnitsByAssetId: new Map([["asset_fondo", "1000"]]),
        workspace,
      }),
    ).filter((signal) => signal.category === "savings_coherence");
  }

  const fireConfig = (
    monthlySavingsCapacityMinor: number | undefined,
  ): FireScopeConfig => ({
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.04,
    ...(monthlySavingsCapacityMinor === undefined ? {} : { monthlySavingsCapacityMinor }),
  });

  test("flags a declared capacity the ledger cannot back", () => {
    const signals = collect(fireConfig(150_000), monthlyBuys("asset_fondo", 120));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      category: "savings_coherence",
      code: "SAVINGS_DECLARED_VS_MEASURED",
      fixable: true,
      severity: "medium",
    });
    // All three figures on show, and no verdict on which one is wrong.
    const euros = (amountMinor: number) =>
      formatMoneyMinor({ amountMinor, currency: "EUR" });
    expect(signals[0]?.label).toContain(euros(150_000));
    expect(signals[0]?.label).toContain(euros(12_000));
    expect(signals[0]?.label).toContain(euros(138_000));
  });

  test("says so plainly when the measured savings are negative", () => {
    const operations = [
      ...monthlyBuys("asset_fondo", 100),
      {
        assetId: "asset_fondo",
        currency: "EUR" as const,
        executedAt: "2026-04-10",
        feesMinor: 0,
        id: "sell-big",
        kind: "sell" as const,
        pricePerUnit: "1",
        units: "5000",
      },
    ];

    expect(collect(fireConfig(100_000), operations)[0]?.label).toContain(
      "te descapitalizas",
    );
  });

  test("stays quiet when declared and measured agree", () => {
    expect(collect(fireConfig(120_000), monthlyBuys("asset_fondo", 1200))).toEqual([]);
  });

  test("stays quiet with no FIRE config to disagree with", () => {
    expect(collect(undefined, monthlyBuys("asset_fondo", 120))).toEqual([]);
  });

  test("stays quiet with an empty ledger", () => {
    expect(collect(fireConfig(150_000), [])).toEqual([]);
  });

  test("ignores a ledger the scope does not own", () => {
    expect(
      collect(fireConfig(150_000), monthlyBuys("asset_fondo", 120), "asset_ajeno"),
    ).toEqual([]);
  });
});

describe("collectDataQualitySignals — MISSING_INVESTMENT_ISIN (#1489)", () => {
  const { asset, input } = fixture();

  const fund = (id: string, overrides: Partial<CreateManualAssetInput> = {}) =>
    asset({
      id,
      instrument: "etf",
      name: `Fondo ${id}`,
      providerSymbol: "SXR1.DE",
      type: "investment",
      ...overrides,
    });

  const codes = (
    assets: ReturnType<typeof asset>[],
    overrides: Partial<CollectDataQualitySignalsInput> = {},
  ): string[] =>
    collectDataQualitySignals(input({ assets, ...overrides })).map(
      (signal) => signal.code,
    );

  test("an investment priced by a symbol with no ISIN is an orphan", () => {
    const signals = collectDataQualitySignals(input({ assets: [fund("inv1")] }));
    const orphan = signals.find((signal) => signal.code === "MISSING_INVESTMENT_ISIN");

    expect(orphan).toMatchObject({
      affected: { id: "inv1", label: "Fondo inv1", object: "holding" },
      category: "missing_configuration",
      fixable: true,
      severity: "low",
    });
    expect(orphan?.label).toContain("ISIN");
  });

  test("an investment that carries its ISIN is silent", () => {
    expect(codes([fund("inv1", { isin: "IE00B52MJY50" })])).not.toContain(
      "MISSING_INVESTMENT_ISIN",
    );
  });

  test("a symbol-less investment is silent — MISSING_PROVIDER_SYMBOL owns that state", () => {
    const emitted = codes([
      asset({ id: "inv1", instrument: "etf", name: "Fondo pelado", type: "investment" }),
    ]);

    expect(emitted).toContain("MISSING_PROVIDER_SYMBOL");
    expect(emitted).not.toContain("MISSING_INVESTMENT_ISIN");
  });

  test("crypto is silent: a coin has no ISIN to be missing", () => {
    expect(
      codes([fund("inv1", { instrument: "crypto", providerSymbol: "bitcoin" })]),
    ).not.toContain("MISSING_INVESTMENT_ISIN");
  });

  test("a connected-source holding is silent — its identity is the source's", () => {
    expect(codes([fund("inv1", { connectedSourceId: "src_binance" })])).not.toContain(
      "MISSING_INVESTMENT_ISIN",
    );
  });

  test("a sold-out position is silent: no statement will ever route to it again", () => {
    expect(
      codes([fund("inv1")], { netUnitsByAssetId: new Map([["inv1", "0"]]) }),
    ).not.toContain("MISSING_INVESTMENT_ISIN");
    expect(
      codes([fund("inv1")], { netUnitsByAssetId: new Map([["inv1", "12.5"]]) }),
    ).toContain("MISSING_INVESTMENT_ISIN");
  });

  test("a hand-valued holding is silent — it has no instrument identity", () => {
    expect(codes([asset({ id: "a1", name: "Cuenta", type: "cash" })])).not.toContain(
      "MISSING_INVESTMENT_ISIN",
    );
  });

  test("acknowledging it labels the signal instead of removing it", () => {
    const signals = collectDataQualitySignals(
      input({
        assets: [fund("inv1")],
        warningOverrides: [{ code: "MISSING_INVESTMENT_ISIN", entityId: "inv1" }],
      }),
    );

    expect(
      signals.find((signal) => signal.code === "MISSING_INVESTMENT_ISIN")?.label,
    ).toContain("marcado como intencional");
  });
});

describe("collectDataQualitySignals — DEBT_MISSING_FROM_HISTORY (#1438)", () => {
  const mortgage = (workspace: Workspace) =>
    createLiability(workspace, {
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "liab_h",
      name: "Hipoteca Santander",
      ownership: owner(),
      type: "mortgage",
    });

  test("amortizable with start in 2004 and N holdings snapshots all without that row → one signal", () => {
    const { input, workspace } = fixture();
    const liability = mortgage(workspace);
    const signals = collectDataQualitySignals(
      input({
        amortizableStartByLiabilityId: new Map([["liab_h", "2004-06-01"]]),
        debtModelByLiabilityId: new Map([["liab_h", "amortizable"]]),
        liabilities: [liability],
        snapshotHoldings: [
          { dateKey: "2010-01-01", holdingId: "asset_cash", kind: "asset" },
          { dateKey: "2015-01-01", holdingId: "asset_cash", kind: "asset" },
          { dateKey: "2020-01-01", holdingId: "asset_cash", kind: "asset" },
        ],
      }),
    ).filter((signal) => signal.code === "DEBT_MISSING_FROM_HISTORY");

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      affected: { id: "liab_h", label: "Hipoteca Santander", object: "holding" },
      category: "history_coverage",
      fixable: true,
      observedDate: "2004-06-01",
      severity: "high",
    });
    expect(signals[0]!.label).toBe(
      'La deuda "Hipoteca Santander" no aparece en ninguna captura histórica posterior a su inicio (2004-06-01).',
    );
  });

  test("the same debt present in at least one snapshot of the range → zero signals", () => {
    const { input, workspace } = fixture();
    const liability = mortgage(workspace);
    const signals = collectDataQualitySignals(
      input({
        amortizableStartByLiabilityId: new Map([["liab_h", "2004-06-01"]]),
        debtModelByLiabilityId: new Map([["liab_h", "amortizable"]]),
        liabilities: [liability],
        snapshotHoldings: [
          { dateKey: "2010-01-01", holdingId: "asset_cash", kind: "asset" },
          { dateKey: "2015-01-01", holdingId: "liab_h", kind: "liability" },
        ],
      }),
    ).filter((signal) => signal.code === "DEBT_MISSING_FROM_HISTORY");

    expect(signals).toHaveLength(0);
  });

  test("no snapshots with holdings in the range → zero signals (does not duplicate NO_SNAPSHOTS)", () => {
    const { input, workspace } = fixture();
    const liability = mortgage(workspace);
    const signals = collectDataQualitySignals(
      input({
        amortizableStartByLiabilityId: new Map([["liab_h", "2004-06-01"]]),
        debtModelByLiabilityId: new Map([["liab_h", "amortizable"]]),
        liabilities: [liability],
        snapshotHoldings: [
          { dateKey: "2000-01-01", holdingId: "asset_cash", kind: "asset" },
        ],
        snapshots: [],
      }),
    );

    expect(signals.map((signal) => signal.code)).not.toContain(
      "DEBT_MISSING_FROM_HISTORY",
    );
  });

  test("a new debt against history that predates its start is silent", () => {
    const { input, workspace } = fixture();
    const liability = mortgage(workspace);
    const signals = collectDataQualitySignals(
      input({
        amortizableStartByLiabilityId: new Map([["liab_h", "2024-01-01"]]),
        debtModelByLiabilityId: new Map([["liab_h", "amortizable"]]),
        liabilities: [liability],
        snapshotHoldings: [
          { dateKey: "2010-01-01", holdingId: "asset_cash", kind: "asset" },
          { dateKey: "2015-01-01", holdingId: "asset_cash", kind: "asset" },
        ],
      }),
    ).filter((signal) => signal.code === "DEBT_MISSING_FROM_HISTORY");

    expect(signals).toHaveLength(0);
  });
});
