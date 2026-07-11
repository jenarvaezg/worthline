import { describe, expect, test } from "vitest";
import type { SourcePosition } from "./connected-source";
import {
  type CollectDataQualitySignalsInput,
  collectDataQualitySignals,
  compareDataQualitySignals,
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
    assets: [],
    connectedSources: [],
    debtModelByLiabilityId: new Map(),
    fireConfigByScopeId: {},
    liabilities: [],
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

function seededInput() {
  const { asset, input } = fixture();
  return input({
    assets: [
      asset({
        currentValueMinor: 0,
        id: "asset_zero",
        liquidityTier: "illiquid",
        name: "Cuadro sin tasar",
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
    const categoryRank: Record<string, number> = {
      warning: 0,
      price_freshness: 1,
      source_freshness: 2,
      missing_configuration: 3,
      history_coverage: 4,
      projection_gap: 5,
    };

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
});
