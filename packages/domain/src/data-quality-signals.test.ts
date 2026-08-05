import { describe, expect, test } from "vitest";
import type { SourcePosition } from "./connected-source";
import {
  type CollectDataQualitySignalsInput,
  collectDataQualitySignals,
  compareDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  type DataQualitySignal,
} from "./data-quality-signals";
import { listScopeOptions, type ScopeOption } from "./scope";
import {
  type CreateManualAssetInput,
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
    connectedSources: [],
    debtModelByLiabilityId: new Map(),
    fireConfigByScopeId: {},
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
    snapshots: [],
    sourceFreshnessBySourceId: new Map(),
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
  const trashed = (
    netUnits: Array<[string, string]>,
    ownerMemberIds: readonly string[] = ["member_jose"],
  ) => {
    const { input } = fixture();
    return collectDataQualitySignals(
      input({
        netUnitsByAssetId: new Map(netUnits),
        trashedHoldings: [{ id: "asset_fondo", name: "Fondo Indexado", ownerMemberIds }],
      }),
    ).filter((signal) => signal.category === "trashed_balance");
  };

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
});
