import { describe, expect, test } from "vitest";

import {
  OWNING_SOURCE_FAILING_CODES,
  OWNING_SOURCE_STOPPED_CODE,
  OWNING_SOURCE_UNSYNCED_CODE,
} from "./data-quality-owning-source-health";
import {
  type CollectDataQualitySignalsInput,
  collectDataQualitySignals,
  type DataQualitySyncAttempt,
  PERSISTENT_SYNC_FAILURE_CODE,
} from "./data-quality-signals";
import { listScopeOptions } from "./scope";
import { createManualAsset, createWorkspace } from "./workspace-types";

const workspace = createWorkspace({
  members: [{ id: "member_titular", name: "Titular" }],
  mode: "individual",
});
const scopeOption = listScopeOptions(workspace)[0]!;
const linked = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 3_217_41,
  id: "asset_fondo",
  liquidityTier: "market",
  name: "Fondo indexado",
  ownership: [{ memberId: "member_titular", shareBps: 10_000 }],
  type: "manual",
});

const failedOn = (day: string, step: string): DataQualitySyncAttempt => ({
  at: `${day}T07:13:00.000Z`,
  failedStep: step,
  status: "error",
});

function collect(overrides: Partial<CollectDataQualitySignalsInput>) {
  return collectDataQualitySignals({
    amortizableStartByLiabilityId: new Map(),
    asOfDateKey: "2026-11-04",
    assetCreatedAtById: new Map(),
    assets: [linked],
    connectedSources: [
      {
        assetIds: ["asset_fondo"],
        id: "src_myinvestor",
        label: "MyInvestor",
        lastSyncAt: "2026-11-01T07:13:00.000Z",
      },
    ],
    debtModelByLiabilityId: new Map(),
    debtServiceByLiabilityId: new Map(),
    fireConfigByScopeId: {},
    holdingValueByHoldingId: new Map(),
    incomes: [],
    investmentOperationsByAssetId: new Map(),
    liabilities: [],
    managedPortfolios: [],
    manualValueHistoryByAssetId: new Map(),
    netUnitsByAssetId: new Map(),
    owningSourceStandingBySourceId: new Map([
      ["src_myinvestor", { savedPassword: true, stop: null }],
    ]),
    positionsBySourceId: new Map(),
    priceFreshnessByAssetId: new Map(),
    scope: { internalScopeId: scopeOption.id, scopeLabel: scopeOption.label },
    scopeOption,
    snapshotHoldings: [],
    snapshotIdsWithHoldings: new Set(),
    snapshots: [],
    sourceFreshnessBySourceId: new Map(),
    syncAttemptsBySourceId: new Map(),
    trashedHoldings: [],
    warningOverrides: [],
    workspace,
    ...overrides,
  }).filter((signal) => signal.category === "source_freshness");
}

describe("the health of a connection that owns its holdings, in data health (#1885)", () => {
  test("three days failing on the orders: «El conector falla», linked to the connection", () => {
    const signals = collect({
      syncAttemptsBySourceId: new Map([
        [
          "src_myinvestor",
          [
            failedOn("2026-11-04", "orders"),
            failedOn("2026-11-03", "orders"),
            failedOn("2026-11-02", "orders"),
          ],
        ],
      ]),
    });

    expect(signals).toEqual([
      {
        affected: {
          id: "src_myinvestor",
          label: "MyInvestor",
          object: "connected_source",
        },
        category: "source_freshness",
        code: OWNING_SOURCE_FAILING_CODES.orders,
        fixable: false,
        label:
          'El conector de "MyInvestor" falla al leer las órdenes desde hace 3 días: las operaciones nuevas pueden faltar.',
        naturalKey: `source_freshness:${OWNING_SOURCE_FAILING_CODES.orders}:src_myinvestor`,
        observedDate: "2026-11-02",
        severity: "high",
      },
    ]);
  });

  test("its own rule replaces the generic count of failed runs: two failures say nothing", () => {
    const signals = collect({
      syncAttemptsBySourceId: new Map([
        [
          "src_myinvestor",
          [failedOn("2026-11-04", "orders"), failedOn("2026-11-04", "orders")],
        ],
      ]),
    });

    expect(signals.map((signal) => signal.code)).not.toContain(
      PERSISTENT_SYNC_FAILURE_CODE,
    );
    expect(signals).toEqual([]);
  });

  test("the SMS stop, with the connection as its way out", () => {
    const signals = collect({
      owningSourceStandingBySourceId: new Map([
        ["src_myinvestor", { savedPassword: true, stop: "sms_required" }],
      ]),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      code: OWNING_SOURCE_STOPPED_CODE,
      label:
        '"MyInvestor" pide verificar el móvil otra vez: la puesta al día diaria está parada hasta que lo hagas.',
      severity: "high",
    });
  });

  test("the rejected saved password", () => {
    const signals = collect({
      owningSourceStandingBySourceId: new Map([
        ["src_myinvestor", { savedPassword: false, stop: "password_forgotten" }],
      ]),
    });

    expect(signals[0]).toMatchObject({
      code: OWNING_SOURCE_STOPPED_CODE,
      label:
        '"MyInvestor" no acepta la contraseña guardada y worthline la ha borrado: la puesta al día diaria está parada.',
    });
  });

  test("45 days without a sync and no password: the soft reminder, low", () => {
    const signals = collect({
      connectedSources: [
        {
          assetIds: ["asset_fondo"],
          id: "src_myinvestor",
          label: "MyInvestor",
          lastSyncAt: "2026-09-20T18:02:00.000Z",
        },
      ],
      owningSourceStandingBySourceId: new Map([
        ["src_myinvestor", { savedPassword: false, stop: null }],
      ]),
    });

    expect(signals).toEqual([
      expect.objectContaining({
        code: OWNING_SOURCE_UNSYNCED_CODE,
        label:
          'Llevas 45 días sin poner al día "MyInvestor". Sin la contraseña guardada, solo se pone al día cuando pulsas.',
        observedDate: "2026-09-20",
        severity: "low",
      }),
    ]);
  });

  test("a source outside the scope says nothing in it", () => {
    const signals = collect({
      assets: [],
      owningSourceStandingBySourceId: new Map([
        ["src_myinvestor", { savedPassword: true, stop: "sms_required" }],
      ]),
    });

    expect(signals).toEqual([]);
  });
});
