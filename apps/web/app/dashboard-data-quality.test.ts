/**
 * Home-hero side of the closed-position filter (#1348).
 *
 * `collectDashboardDataQualitySignals` is the hero's half of the shared #654
 * engine; `buildDataQuality` is the agent view's. The issue asks that both read
 * ONE filter, and the engine enforces it by making `netUnitsByAssetId` required —
 * but "required" only proves a map arrives, not that this gather folds the right
 * ledger into it. These tests pin that end: given the investment ledger the
 * dashboard already read, a sold-out holding is silent on the hero exactly as it
 * is over the agent-view HTTP contract
 * (`tests/agent-view-data-quality.wiring.test.ts`).
 */

import type { AgentViewReadStore, AgentViewTrashedHolding } from "@worthline/db";
import {
  createManualAsset,
  createWorkspace,
  type InvestmentOperation,
  listScopeOptions,
  type ManualAsset,
} from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { collectDashboardDataQualitySignals } from "./dashboard-data-quality";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});
const scope = listScopeOptions(workspace)[0]!;

function emptyStore(trashedHoldings: AgentViewTrashedHolding[] = []): AgentViewReadStore {
  return {
    readAssetCreatedAtById: async () => new Map(),
    readConnectedSources: async () => [],
    readManualValueHistory: async () => new Map(),
    readTrashedHoldings: async () => trashedHoldings,
  } as unknown as AgentViewReadStore;
}

function symbollessFund(): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 0,
    id: "asset_fund",
    instrument: "fund",
    liquidityTier: "market",
    name: "Fondo sin símbolo",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  });
}

function operation(kind: "buy" | "sell", units: string, id: string): InvestmentOperation {
  return {
    assetId: "asset_fund",
    currency: "EUR",
    executedAt: kind === "buy" ? "2026-01-10" : "2026-06-10",
    feesMinor: 0,
    id,
    kind,
    pricePerUnit: "100",
    units,
  };
}

async function heroSignals(
  operations: readonly InvestmentOperation[],
  trashedHoldings: AgentViewTrashedHolding[] = [],
  assets: ManualAsset[] = [symbollessFund()],
) {
  return collectDashboardDataQualitySignals({
    agentView: emptyStore(trashedHoldings),
    asOfDateKey: "2026-07-11",
    assets,
    fireConfigByScopeId: { [scope.id]: undefined },
    holdingRows: [],
    liabilities: [],
    operationsByAsset: new Map([["asset_fund", operations]]),
    overrides: [],
    priceCache: [],
    scope,
    snapshots: [],
    workspace,
  });
}

async function heroCodes(operations: readonly InvestmentOperation[]): Promise<string[]> {
  return (await heroSignals(operations))
    .filter((signal) => signal.category === "warning")
    .map((signal) => signal.code);
}

describe("collectDashboardDataQualitySignals — closed positions (#1348)", () => {
  test("asks only for the loaded assets' manual-value history (#1534)", async () => {
    const readManualValueHistory = vi.fn(async () => new Map());
    await collectDashboardDataQualitySignals({
      agentView: { ...emptyStore(), readManualValueHistory } as AgentViewReadStore,
      asOfDateKey: "2026-07-11",
      assets: [symbollessFund()],
      fireConfigByScopeId: { [scope.id]: undefined },
      holdingRows: [],
      liabilities: [],
      operationsByAsset: new Map(),
      overrides: [],
      priceCache: [],
      scope,
      snapshots: [],
      workspace,
    });
    expect(readManualValueHistory).toHaveBeenCalledWith(["asset_fund"]);
  });

  test("a sold-out fund raises no warning on the hero", async () => {
    expect(
      await heroCodes([
        operation("buy", "10", "op_buy"),
        operation("sell", "10", "op_sell"),
      ]),
    ).toEqual([]);
  });

  test("the same fund still open raises MISSING_PROVIDER_SYMBOL", async () => {
    expect(await heroCodes([operation("buy", "10", "op_buy")])).toEqual([
      "MISSING_PROVIDER_SYMBOL",
    ]);
  });

  test("a fund with no operation yet is unstarted, not closed", async () => {
    expect(await heroCodes([])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });
});

/**
 * The hero half of the trashed-with-balance signal (#1365). What this pins is the
 * cheap part of the wiring: the trash's net units come from the ledger the
 * dashboard ALREADY read (the shared projection context reads the whole operations
 * table, trashed rows included), so surfacing the signal costs the home GET one
 * read of the trash listing and no per-holding ledger fetch.
 */
describe("collectDashboardDataQualitySignals — trashed with balance (#1365)", () => {
  const trashedFund: AgentViewTrashedHolding = {
    deletedAt: "2026-07-01T10:00:00.000Z",
    id: "asset_fund",
    instrument: "fund",
    kind: "asset",
    name: "Fondo sin símbolo",
    ownerMemberIds: ["member_jose"],
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    trashExit: null,
    valueMinor: 0,
  };

  async function trashedCodes(
    operations: readonly InvestmentOperation[],
  ): Promise<string[]> {
    // The holding is in the trash, so it is NOT among the live assets the
    // dashboard read — only its ledger is still in the operations map.
    return (await heroSignals(operations, [trashedFund], []))
      .filter((signal) => signal.category === "trashed_balance")
      .map((signal) => signal.code);
  }

  test("a fund trashed with units still held reaches the hero", async () => {
    expect(await trashedCodes([operation("buy", "10", "op_buy")])).toEqual([
      "TRASHED_WITH_BALANCE",
    ]);
  });

  test("a fund sold out before being trashed stays silent", async () => {
    expect(
      await trashedCodes([
        operation("buy", "10", "op_buy"),
        operation("sell", "10", "op_sell"),
      ]),
    ).toEqual([]);
  });

  test("a trashed holding with no ledger at all stays silent", async () => {
    expect(await trashedCodes([])).toEqual([]);
  });
});
