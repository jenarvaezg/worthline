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
  housingAssetIdsOf,
  instrumentOfAsset,
  isHousingAsset,
  isLiquid,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
export { LIQUIDITY_LADDER } from "./liquidity-ladder";
export type {
  HoldingValuation,
  HoldingValuationInput,
  ValuationMethod,
} from "./holding-valuation";
export {
  defaultValuationMethodForAssetType,
  defaultValuationMethodForDebtModel,
  valueAt,
} from "./holding-valuation";
export {
  isValueUpdateEligible,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "./holding-method";
export type {
  Instrument,
  InstrumentDefaults,
  InstrumentPriceProvider,
} from "./instrument-catalog";
export {
  defaultInstrumentForAssetType,
  defaultInstrumentForLiability,
  defaultsFor,
  instrumentForQuoteType,
} from "./instrument-catalog";

export type { DomainResult, DomainViolation } from "./domain-result";

export type {
  AssetType,
  CreateLiabilityInput,
  CreateManualAssetInput,
  DebtModel,
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
  FramedDelta,
  FramedSnapshotDeltas,
  NetWorthSnapshot,
  SnapshotDeltas,
  ValuedNetWorthSnapshot,
} from "./snapshot-types";
export {
  calculateSnapshotDeltas,
  captureNetWorthSnapshot,
  captureValuedNetWorthSnapshot,
  createNetWorthSnapshot,
  deriveFramedSnapshotDeltas,
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
export {
  investmentCaptureDetailsFrom,
  projectAssets,
  projectPositions,
  projectScopedPositionsWithDetails,
} from "./asset-projection";

export type {
  CoinPosition,
  CoinValuation,
  ConnectedSource,
  DistributiveOmit,
  MetalGroup,
  PositionValuation,
  ProjectedHolding,
  SourceAdapter,
  SourcePosition,
  TokenPosition,
  TokenValuationBasis,
  ValuationBasis,
} from "./connected-source";
export {
  coinCollectionValueAtDate,
  coinValue,
  groupPositionsByMetal,
  instrumentForAdapter,
  positionValue,
  projectConnectedSource,
  projectedPositionValue,
} from "./connected-source";

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
  ExportedAmortizationPlan,
  ExportedAsset,
  ExportedBalanceAnchor,
  ExportedConnectedSource,
  ExportedEarlyRepayment,
  ExportedInterestRateRevision,
  ExportedInvestmentMeta,
  ExportedLiability,
  ExportedPosition,
  ExportedSnapshot,
  ExportedTrash,
  ExportedValuationAnchor,
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
  ParsedStatement,
  ParsedStatementRow,
  ParseStatementResult,
  SkippedStatementRow,
  StatementBroker,
} from "./statement-parse";
export { parseStatement } from "./statement-parse";
export type {
  StatementAnomaly,
  StatementMergePlan,
  StatementOverwrite,
} from "./statement-merge";
export { planStatementMerge } from "./statement-merge";
export type { StatementIsinGuard } from "./statement-isin";
export { resolveStatementIsinGuard } from "./statement-isin";

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

export type {
  PortfolioGroup,
  PortfolioGroupKey,
  UnifiedHolding,
} from "./portfolio-grouping";
export {
  groupPortfolio,
  instrumentLabel,
  PORTFOLIO_GROUP_KEYS,
} from "./portfolio-grouping";

export type { DecimalString } from "./decimal";
export {
  addUnits,
  averageUnitCost,
  compareUnits,
  divideUnits,
  multiplyToMinor,
  normalizeDecimal,
  proportionMinor,
  subtractUnits,
} from "./decimal";

export type {
  HousingValuationAnchor,
  ValueHousingAtDateInput,
} from "./housing-valuation";
export { valueHousingAtDate } from "./housing-valuation";

export type {
  AmortizableBalanceAtDateInput,
  AmortizationPlanInput,
  EarlyRepayment,
  EarlyRepaymentMode,
  FirstCuota,
  InterestRateRevision,
} from "./amortization";
export {
  addMonths,
  amortizableBalanceAtDate,
  assertEventWithinTerm,
  firstCuota,
  suggestFirstPaymentDate,
} from "./amortization";

export type { DebtBalanceAnchor, DebtBalanceAtDateInput } from "./debt-balance";
export { debtBalanceAtDate } from "./debt-balance";

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
  DebtBalanceCurveInputs,
  FrozenIdentityCapture,
  GlobalHoldingValueInput,
  HousingCurveInputs,
  RecalculateCoinAcquisitionSnapshotInput,
  RecalculateHousingSnapshotInput,
  RecalculateLiabilitySnapshotInput,
  RecalculateOwnershipSnapshotInput,
  RecalculateSnapshotInput,
} from "./historical-snapshot";
export type { ManualValuePoint } from "./value-history";
export { lastKnownValueAtDate } from "./value-history";
export {
  amortizationPaymentDatesUpTo,
  buildSnapshotAtDate,
  globalHoldingValueAtDate,
  historicalCapturedAt,
  recalculateSnapshotForAsset,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
} from "./historical-snapshot";

export {
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
  timeProportionalXs,
} from "./evolution-chart";

export type {
  StackedBandGeometry,
  StackedChartGeometry,
  StackedSeriesInput,
} from "./decomposition-chart";
export { buildStackedChartGeometry } from "./decomposition-chart";

export type {
  BuildCompositionSeriesInput,
  CompositionAssetBandId,
  CompositionBandGeometry,
  CompositionBandHoverPoint,
  CompositionBands,
  CompositionChartGeometry,
  CompositionGranularity,
  CompositionHoverPoint,
  CompositionPeriodGeometry,
  CompositionRange,
  CompositionSeriesPoint,
  MonthlySeriesEntry,
} from "./composition-chart";
export {
  availableCompositionRanges,
  buildCompositionChartGeometry,
  buildCompositionSeries,
  COMPOSITION_ASSET_BANDS,
  COMPOSITION_CHART_HEIGHT,
  COMPOSITION_CHART_INSET_X,
  COMPOSITION_CHART_WIDTH,
  COMPOSITION_RANGES,
  deriveCompositionBands,
  granularityForSpanMonths,
  monthsBetween,
  rangeStartMonthKey,
  selectMonthlySeries,
  selectPeriodicSeries,
} from "./composition-chart";

export type {
  DatedSnapshotHoldingRow,
  DebtDrillBand,
  DebtsDrilldownState,
  DrillHoldingMultiple,
  DrillSparklineGeometry,
  DrilldownInput,
  DrilldownKey,
  DrilldownState,
  GroupDrilldownState,
  HousingDrilldownState,
  LiquidDrillTier,
  LiquidDrilldownInput,
  LiquidDrilldownState,
  RestDrillTier,
  RestDrilldownState,
} from "./drilldown";
export {
  buildDebtsDrilldown,
  buildDrilldown,
  buildHousingDrilldown,
  buildLiquidDrilldown,
  buildRestDrilldown,
  DRILL_GROUP_BY_TIER,
  DRILL_SPARKLINE_HEIGHT,
  DRILL_SPARKLINE_INSET_X,
  DRILL_SPARKLINE_WIDTH,
  LIQUID_DRILL_TIERS,
  REST_DRILL_TIERS,
} from "./drilldown";
