export type { CurrencyCode, MoneyMinor } from "./money";
export {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  formatMoneyMinorPrivacy,
  maskMoneyString,
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
export { LIQUIDITY_LADDER, LIQUIDITY_TIER_LABELS } from "./liquidity-ladder";
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
  LiabilityDefaults,
} from "./instrument-catalog";
export {
  defaultInstrumentForAssetType,
  defaultInstrumentForLiability,
  defaultsFor,
} from "./instrument-catalog";

export type { DomainResult, DomainViolation } from "./domain-result";

export type { Clock } from "./clock";
export { fixedClock, systemClock } from "./clock";

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
  RiskTolerance,
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
  DetectPriceBackfillInput,
  PriceBackfillCandidate,
  PriceBackfillCandidateAsset,
  PriceBackfillSnapshotRow,
  SingleAssetBackfillInput,
} from "./price-backfill-detection";
export {
  detectPriceBackfillCandidates,
  detectSingleAssetBackfillCandidate,
} from "./price-backfill-detection";
export type {
  PlanPriceBackfillInput,
  PriceBackfillAction,
  PriceBackfillPlan,
  PriceBackfillPoint,
} from "./price-backfill-plan";
export { planPriceBackfill } from "./price-backfill-plan";
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
  TokenGroup,
  TokenPosition,
  TokenValuationBasis,
  ValuationBasis,
} from "./connected-source";
export {
  carryForwardTokenUnitPrices,
  coinCollectionValueAtDate,
  coinPositionSnapshotInput,
  coinValue,
  frozenInstrumentForAdapter,
  groupPositionsByMetal,
  groupPositionsByToken,
  instrumentForAdapter,
  isTokenDustValue,
  positionValue,
  projectConnectedSource,
  projectedPositionValue,
  TOKEN_DUST_THRESHOLD_MINOR,
  tokenPositionSnapshotInput,
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
  isPriceStale,
  PRICE_TTL_DAYS,
  selectStalePrices,
} from "./prices";

export type { FireScopeConfig, FireResult } from "./fire";
export { calculateFire, calculateFireForScope, fireReservationHorizon } from "./fire";
export type { EligibleTier } from "./fire-return";
export { TIER_REAL_RETURN_DEFAULTS, effectiveRealReturn } from "./fire-return";

export type {
  FireProjection,
  FireProjectionInput,
  FireScenario,
  FireScenarioLabel,
  FireTrajectoryPoint,
} from "./fire-projection";
export { DEFAULT_MAX_YEARS, fractionalFireYear, projectFire } from "./fire-projection";

export type { GoalFireDelay, GoalFireDelayInput } from "./goal-fire-delay";
export { goalFireDelay } from "./goal-fire-delay";
export type { FireLevel, FireLevelKey, FireLevelsInput } from "./fire-levels";
export { fireLevels } from "./fire-levels";

export type { MonthlySavingsSuggestion } from "./monthly-savings";
export { suggestMonthlySavingsCapacity } from "./monthly-savings";

export type { Goal, GoalPriority, GoalReservationInput } from "./goals";
export {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  totalGoalReservationMinor,
} from "./goals";

export type { WarningSeverity, DomainWarning, WarningOverride } from "./warnings";
export { collectWarnings } from "./warnings";

export type { ScopeType, ScopeOption } from "./scope";
export { listScopeOptions, resolveScopeMemberIds } from "./scope";

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
  ExportedPublicId,
  ExportedPublicIdEntityType,
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
export { parseStatement, parseStatementWithAdapter } from "./statement-parse";
export type {
  ColumnResolution,
  StatementBrokerAdapter,
  StatementRowOutcome,
  StatementRowResult,
} from "./statement-broker-adapter";
export { getStatementBrokerAdapter, isStatementBroker } from "./statement-broker-adapter";
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
  HoldingDelta,
  InvestmentCaptureDetail,
  PositionDelta,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  SnapshotPositionInput,
  SnapshotPositionRow,
  SnapshotReconciliationTotals,
} from "./snapshot-holdings";
export {
  assertSnapshotHoldingsReconcile,
  buildSnapshotHoldingRows,
  deriveHoldingDeltas,
  derivePositionDeltas,
} from "./snapshot-holdings";

export type {
  PortfolioProjection,
  PortfolioProjectionInput,
  PortfolioSection,
  AssetsSection,
  LiabilitiesSection,
  ProjectedAssetRow,
  ProjectedLiabilityRow,
  PriceRefreshMeta,
  RowOwnership,
} from "./portfolio-projection";
export { projectPortfolio } from "./portfolio-projection";

export type {
  PortfolioGroup,
  PortfolioGroupKey,
  UnifiedHolding,
} from "./portfolio-grouping";
export { groupPortfolio, PORTFOLIO_GROUP_KEYS } from "./portfolio-grouping";

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

export type { InterpolateOrStepInput, ValuationCadence } from "./valuation-cadence";
export {
  cadenceOrDefault,
  interpolateOrStep,
  sampleDateForCadence,
} from "./valuation-cadence";

export { daysBetween, MS_PER_DAY } from "./dates";

export type {
  DashboardState,
  FireGlance,
  LocalPersistenceStatus,
  ObjetivosGoalView,
  ObjetivosState,
  OnboardingStep,
} from "./dashboard";
export {
  deriveOnboardingProgress,
  largestRemainderPercentages,
  prepareDashboardState,
  prepareObjetivosState,
} from "./dashboard";

export type { DonutArcSegment, DonutGeometry } from "./donut";
export { donutArcSegments } from "./donut";

export type { SnapshotPolicyEntry } from "./snapshot-policy";
export {
  deriveConfirmedMonthlyCloseIds,
  deriveMonthlyCloses,
  findTodaySnapshotId,
} from "./snapshot-policy";

export type { CaptureSnapshotInput, CaptureSnapshotOutput } from "./capture-snapshot";
export { buildSnapshotId, captureSnapshotForScope } from "./capture-snapshot";

export type {
  BuildSnapshotAtDateInput,
  DebtBalanceCurveInputs,
  FrozenIdentityCapture,
  GlobalHoldingValueInput,
  HousingCurveInputs,
  RecalculateCoinAcquisitionSnapshotInput,
  RecalculateConnectedValueSnapshotInput,
  RecalculateHousingSnapshotInput,
  RecalculateLiabilitySnapshotInput,
  RecalculateOwnershipSnapshotInput,
  RecalculateSnapshotInput,
} from "./historical-snapshot";
export type { ManualValuePoint } from "./value-history";
export { lastKnownValueAtDate } from "./value-history";
export type { BinanceHistoryCurve } from "./binance-history";
export {
  binanceCurveStartDate,
  binanceValueAtDate,
  completedMonthEndDates,
} from "./binance-history";
export {
  amortizationPaymentDatesUpTo,
  buildSnapshotAtDate,
  globalHoldingValueAtDate,
  historicalCapturedAt,
  recalculateSnapshotForAsset,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
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
  StackedBarRect,
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
  CompositionBarRect,
  CompositionChartGeometry,
  CompositionGranularity,
  CompositionHousingMode,
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
  selectPeriodicSeries,
} from "./composition-chart";

export type {
  DatedSnapshotHoldingRow,
  DebtDrillBand,
  DebtsDrilldownState,
  DrillBarRect,
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
  DRILL_SPARKLINE_MIN_BAR_HEIGHT,
  DRILL_SPARKLINE_WIDTH,
  LIQUID_DRILL_TIERS,
  REST_DRILL_TIERS,
} from "./drilldown";
