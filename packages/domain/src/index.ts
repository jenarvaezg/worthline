export type { CurrencyCode, MoneyMinor } from "./money";
export {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  money,
  moneySign,
  parseDecimal,
  parseDecimalStrict,
  parseDecimalToMinor,
  parseDecimalToMinorStrict,
  subtractMoney,
} from "./money";

export type { LiquidityTier } from "./classification";
export {
  isHousing,
  isHousingAsset,
  isLiquid,
  tierOfAsset,
  tierOfLiability,
} from "./classification";

export type { DomainResult, DomainViolation } from "./domain-result";

export type {
  AssetType,
  CreateLiabilityInput,
  CreateManualAssetInput,
  Liability,
  LiabilityType,
  ManualAsset,
  Member,
  MemberGroup,
  OwnershipShare,
  Workspace,
  WorkspaceMode,
} from "./workspace-types";
export {
  checkOwnershipSplit,
  createLiability,
  createLiabilitySafe,
  createManualAsset,
  createManualAssetSafe,
  createWorkspace,
} from "./workspace-types";

export type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  OperationKind,
  PositionSummary,
} from "./investment-types";

export type {
  LiquidityComponent,
  LiquidityTierBreakdown,
  NetWorthBreakdownId,
  NetWorthBreakdownItem,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSummary,
} from "./net-worth";
export {
  buildLiquidityBreakdown,
  calculateNetWorth,
  defaultLiquidityTierOrder,
  presentNetWorth,
} from "./net-worth";

export type {
  CreateNetWorthSnapshotInput,
  NetWorthSnapshot,
  SnapshotDeltas,
  ValuedNetWorthSnapshot,
} from "./snapshot-types";
export {
  calculateSnapshotDeltas,
  captureNetWorthSnapshot,
  captureValuedNetWorthSnapshot,
  createNetWorthSnapshot,
} from "./snapshot-types";

export type { DashboardShell } from "./dashboard-shell";
export { createDashboardShell } from "./dashboard-shell";

export {
  createInvestmentOperation,
  createInvestmentOperationSafe,
  derivePosition,
} from "./positions";
export type {
  InvestmentPriceSource,
  SelectedInvestmentPrice,
  DeriveInvestmentValuationInput,
  InvestmentValuation,
} from "./investment-valuation";
export {
  assertNotInvestmentAsset,
  deriveInvestmentValuation,
  selectInvestmentPrice,
} from "./investment-valuation";
export type {
  AssetProjectionContext,
  PositionProjection,
  RawAssetRow,
  RawInvestmentRow,
} from "./asset-projection";
export { projectAssets, projectPositions } from "./asset-projection";

export type {
  AssetPrice,
  InvestmentPriceProvider,
  PriceFreshnessState,
  PriceSource,
} from "./prices";
export {
  defaultInvestmentPriceProvider,
  getPriceFreshness,
  PRICE_TTL_DAYS,
  selectStalePrices,
} from "./prices";

export type { FireScopeConfig, FireResult } from "./fire";
export { filterFireEligibleAssets, calculateFire, calculateFireForScope } from "./fire";

export type { WarningSeverity, DomainWarning, WarningOverride } from "./warnings";
export { collectWarnings } from "./warnings";

export type { ScopeType, ScopeOption } from "./scope";
export { listScopeOptions, resolveScopeMemberIds } from "./scope";

export { allocateOwnedMoneyMinor } from "./ownership";

export type { ScopedHolding } from "./scope-allocation";
export { allocateScopedHolding } from "./scope-allocation";

export type {
  ExportedAsset,
  ExportedInvestmentMeta,
  ExportedLiability,
  ExportedSnapshot,
  ExportedTrash,
  ExportedWorkspaceConfig,
  WorkspaceExport,
  WorkspaceExportData,
  WorkspaceExportSummary,
} from "./workspace-transfer";
export {
  EXPORT_VERSION,
  serializeWorkspaceExport,
  summarizeWorkspaceExport,
} from "./workspace-transfer";
export type { ParseWorkspaceExportResult } from "./workspace-transfer-parse";
export { parseWorkspaceExport } from "./workspace-transfer-parse";

export type {
  BuildSnapshotHoldingRowsInput,
  InvestmentCaptureDetail,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  SnapshotReconciliationTotals,
} from "./snapshot-holdings";
export {
  assertSnapshotHoldingsReconcile,
  buildSnapshotHoldingRows,
} from "./snapshot-holdings";

export type {
  PortfolioProjection,
  PortfolioProjectionInput,
  PortfolioSection,
  AssetsSection,
  LiabilitiesSection,
  ProjectedAssetRow,
  ProjectedLiabilityRow,
  RowOwnership,
} from "./portfolio-projection";
export { projectPortfolio } from "./portfolio-projection";

export type { DecimalString } from "./decimal";

export type {
  HousingValuationAnchor,
  ValueHousingAtDateInput,
} from "./housing-valuation";
export { valueHousingAtDate } from "./housing-valuation";

export type { DashboardState, LocalPersistenceStatus, OnboardingStep } from "./dashboard";
export {
  deriveOnboardingProgress,
  largestRemainderPercentages,
  prepareDashboardState,
  signedDeltaBarWidths,
} from "./dashboard";

export type { DonutArcSegment, DonutGeometry } from "./donut";
export { donutArcSegments } from "./donut";

export type { CaptureDecision, SnapshotPolicyEntry } from "./snapshot-policy";
export { deriveMonthlyCloses, planSnapshotCapture } from "./snapshot-policy";

export type { CaptureSnapshotInput, CaptureSnapshotOutput } from "./capture-snapshot";
export { buildSnapshotId, captureSnapshotForScope } from "./capture-snapshot";

export type {
  BuildSnapshotAtDateInput,
  ManualValuePoint,
  RecalculateSnapshotInput,
} from "./historical-snapshot";
export {
  buildSnapshotAtDate,
  historicalCapturedAt,
  lastKnownValueAtDate,
  recalculateSnapshotForAsset,
} from "./historical-snapshot";

export type {
  EvolutionChartGeometry,
  EvolutionMarker,
  EvolutionSeriesPoint,
} from "./evolution-chart";
export {
  buildEvolutionChartGeometry,
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
} from "./evolution-chart";

export type {
  DecompositionBandGeometry,
  DecompositionBandId,
  DecompositionBandsPoint,
  DecompositionChartGeometry,
  DecompositionSeriesPoint,
  StackedBandGeometry,
  StackedChartGeometry,
  StackedSeriesInput,
} from "./decomposition-chart";
export {
  buildDecompositionChartGeometry,
  buildStackedChartGeometry,
  deriveDecompositionBands,
} from "./decomposition-chart";

export type {
  DatedSnapshotHoldingRow,
  DrillHoldingMultiple,
  DrillSparklineGeometry,
  DrilldownInput,
  DrilldownKey,
  DrilldownState,
  GroupDrilldownState,
  HousingDrillTier,
  HousingDrilldownState,
  LiquidDrillTier,
  LiquidDrilldownInput,
  LiquidDrilldownState,
  RestDrillTier,
  RestDrilldownState,
} from "./drilldown";
export {
  buildDrilldown,
  buildHousingDrilldown,
  buildLiquidDrilldown,
  buildRestDrilldown,
  DRILL_GROUP_BY_TIER,
  DRILL_SPARKLINE_HEIGHT,
  DRILL_SPARKLINE_INSET_X,
  DRILL_SPARKLINE_WIDTH,
  HOUSING_DRILL_TIERS,
  LIQUID_DRILL_TIERS,
  REST_DRILL_TIERS,
} from "./drilldown";
