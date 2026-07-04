import { describe, expect, test } from "vitest";

import * as domain from "./index";

/**
 * Barrel smoke test (R14 / PRD #120 candidate 5).
 *
 * Guards against silent re-export breakage in ./index.ts: if a leaf module
 * moves, renames, or a re-export line is dropped, the corresponding symbol
 * becomes `undefined` on the barrel without any type error at the import site.
 * This test fails fast when a key public runtime export disappears.
 *
 * Maintainability: this is a curated list of representative runtime exports
 * (one or two per leaf module), NOT an exhaustive mirror of every symbol.
 * Type-only exports are intentionally omitted because they have no runtime
 * presence to assert against.
 */
const KEY_EXPORTS = [
  // money
  "money",
  "formatMoneyMinor",
  "parseDecimalToMinor",
  // classification
  "tierOfAsset",
  "isLiquid",
  // holding-valuation
  "valueAt",
  "defaultValuationMethodForAssetType",
  "defaultValuationMethodForDebtModel",
  "valuationMethodOfAsset",
  "valuationMethodOfLiability",
  // instrument-catalog
  "defaultsFor",
  "defaultInstrumentForAssetType",
  "defaultInstrumentForLiability",
  // value-history
  "lastKnownValueAtDate",
  // workspace-types
  "createWorkspace",
  "createManualAsset",
  "createLiability",
  // net-worth
  "calculateNetWorth",
  "presentNetWorth",
  "buildLiquidityBreakdown",
  // snapshot-types
  "createNetWorthSnapshot",
  "captureNetWorthSnapshot",
  "calculateSnapshotDeltas",
  // dashboard-shell
  "createDashboardShell",
  // positions
  "createInvestmentOperation",
  "derivePosition",
  // returns (#548)
  "operationCashflows",
  "operationTwrCashflows",
  "xirr",
  "simpleGain",
  "holdingIrr",
  "holdingTwr",
  "monthlyCloseValuesFromSnapshotRows",
  "portfolioSimpleGain",
  "portfolioIrr",
  "portfolioTwr",
  "timeWeightedReturn",
  "simpleGainFromCashflows",
  // returns-by-class (#552)
  "returnsByAssetClass",
  "returnsByAssetClassView",
  // investment-valuation
  "deriveInvestmentValuation",
  "selectInvestmentPrice",
  // asset-projection
  "projectAssets",
  "projectPositions",
  // connected-source
  "projectConnectedSource",
  "coinValue",
  "groupPositionsByMetal",
  // prices
  "defaultInvestmentPriceProvider",
  "getPriceFreshness",
  "isPriceStale",
  // fire
  "calculateFire",
  // warnings
  "collectWarnings",
  // scope
  "listScopeOptions",
  "resolveScopeMemberIds",
  // scope-allocation
  "allocateScopedHolding",
  // workspace-transfer
  "serializeWorkspaceExport",
  "summarizeWorkspaceExport",
  // workspace-transfer-parse
  "parseWorkspaceExport",
  // snapshot-holdings
  "buildSnapshotHoldingRows",
  "assertSnapshotHoldingsReconcile",
  // portfolio-projection
  "projectPortfolio",
  // exposure look-through (#540)
  "createExposureProfile",
  "lookThroughExposure",
  "resolveAssetClassBreakdown",
  // portfolio-grouping (#154)
  "groupPortfolio",
  // dashboard
  "prepareDashboardState",
  "deriveOnboardingProgress",
  // donut
  "donutArcSegments",
  // snapshot-policy
  "deriveMonthlyCloses",
  "findTodaySnapshotId",
  // capture-snapshot
  "buildSnapshotId",
  "captureSnapshotForScope",
  // historical-snapshot
  "buildSnapshotAtDate",
  "recalculateSnapshotForAsset",
  "recalculateSnapshotForLiability",
  "amortizationPaymentDatesUpTo",
  // composition-chart (#142)
  "buildCompositionSeries",
  "buildCompositionChartGeometry",
  // decomposition-chart (generic stacked geometry)
  "buildStackedChartGeometry",
  // drilldown
  "buildDrilldown",
  "buildLiquidDrilldown",
  // housing-valuation
  "valueHousingAtDate",
  // amortization
  "amortizableBalanceAtDate",
  // debt-balance
  "debtBalanceAtDate",
  // dates
  "daysBetween",
] as const;

describe("@worthline/domain barrel", () => {
  test.each(KEY_EXPORTS)("re-exports %s as a defined value", (name) => {
    expect(domain[name as keyof typeof domain]).toBeDefined();
  });

  test("every key export is callable (function-valued)", () => {
    for (const name of KEY_EXPORTS) {
      expect(typeof domain[name as keyof typeof domain]).toBe("function");
    }
  });
});
