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

import type { AgentViewReadStore } from "@worthline/db";
import {
  createManualAsset,
  createWorkspace,
  type InvestmentOperation,
  listScopeOptions,
  type ManualAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { collectDashboardDataQualitySignals } from "./dashboard-data-quality";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});
const scope = listScopeOptions(workspace)[0]!;

function emptyStore(): AgentViewReadStore {
  return {
    readAssetCreatedAtById: async () => new Map(),
    readConnectedSources: async () => [],
    readManualValueHistory: async () => new Map(),
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

async function heroCodes(operations: readonly InvestmentOperation[]): Promise<string[]> {
  const signals = await collectDashboardDataQualitySignals({
    agentView: emptyStore(),
    asOfDateKey: "2026-07-11",
    assets: [symbollessFund()],
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

  return signals
    .filter((signal) => signal.category === "warning")
    .map((signal) => signal.code);
}

describe("collectDashboardDataQualitySignals — closed positions (#1348)", () => {
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
