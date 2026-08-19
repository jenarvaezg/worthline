export type {
  AmortizableBalanceAtDateInput,
  AmortizationPlanInput,
  AmortizationScheduleEvent,
  AmortizationSchedulePeriod,
  AmortizationScheduleTrace,
  BalanceRebaselineInput,
  CurrentStateAmortizationDerivation,
  CurrentStateAmortizationInput,
  EarlyRepayment,
  EarlyRepaymentMode,
  FirstCuota,
  InterestRateRevision,
} from "./amortization";
export {
  addMonths,
  amortizableBalanceAtDate,
  amortizationPlanFromBalanceRebaseline,
  amortizationScheduleTrace,
  assertEventWithinTerm,
  deriveCurrentStateAmortizationPlan,
  eventBoundaryDate,
  firstCuota,
  monthlyPaymentMinorFromRate,
  remainingMonthlyPayments,
  solveAnnualInterestRateFromPayment,
  suggestFirstPaymentDate,
} from "./amortization";
export type {
  AmortizationScheduleReading,
  AmortizationScheduleReadResult,
  ScheduleDeclaredBalance,
  ScheduleEarlyRepayment,
  ScheduleRateRevision,
  ScheduleSheet,
} from "./amortization-schedule-adapter";
export { readAmortizationSchedule } from "./amortization-schedule-adapter";
export type {
  AmortizationScheduleImportContext,
  AmortizationScheduleImportPlan,
  PlannedEarlyRepayment,
  PlannedRevision,
  ScheduleCheckpoint,
  ScheduleEventStatus,
  ScheduleImportSummary,
} from "./amortization-schedule-import";
export { buildAmortizationScheduleImportPlan } from "./amortization-schedule-import";
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
export { balancesAgree, balanceToleranceMinor } from "./balance-tolerance";
export type { BenchmarkCatalogEntry, BenchmarkVariant } from "./benchmark-catalog";
export {
  BENCHMARK_CATALOG,
  benchmarkCatalogEntryBySeriesId,
  benchmarkCoverageNote,
  listMarketIndexSeriesIds,
  listTrackedIndexLabels,
  resolveBenchmarkSeriesId,
} from "./benchmark-catalog";
export type {
  BenchmarkComparison,
  BenchmarkComparisonPoint,
  BenchmarkComparisonResult,
  BenchmarkComparisonUnavailableReason,
  GrowthSeriesPoint,
} from "./benchmark-comparison";
export { compareGrowthToBenchmark } from "./benchmark-comparison";
export type { BinanceHistoryCurve } from "./binance-history";
export {
  binanceCurveStartDate,
  binanceValueAtDate,
  completedMonthEndDates,
} from "./binance-history";
export type {
  BrokerTransactionRow,
  BrokerTransactionTable,
  TransactionDirectionSource,
} from "./broker-transaction-table";
export {
  ASSUMED_BUY_WARNING,
  readBrokerTransactionTable,
} from "./broker-transaction-table";
export type { CaptureSnapshotInput, CaptureSnapshotOutput } from "./capture-snapshot";
export { buildSnapshotId, captureSnapshotForScope } from "./capture-snapshot";
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
export type { Clock } from "./clock";
export { fixedClock, systemClock } from "./clock";
export type { CoinValueGap, CoinValueGapInput } from "./coin-value-gap";
export {
  COIN_VALUE_GAP_LABEL,
  coinValueGap,
  summarizeCoinValueGaps,
} from "./coin-value-gap";
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
  mergeCoinPositionSnapshotInputs,
  positionValue,
  projectConnectedSource,
  projectedPositionValue,
  TOKEN_DUST_THRESHOLD_MINOR,
  tokenSymbolSnapshotInputs,
} from "./connected-source";
export type {
  InboxDecision,
  InboxDecisionInput,
  InboxDisposition,
  InboxPlan,
  InboxReconcileInput,
  InboxRow,
  InboxRowAction,
  SkipReason,
} from "./connector-inbox";
export { reconcileInbox, resolveInbox } from "./connector-inbox";
export type {
  ConnectorAccount,
  ConnectorAdapter,
  ConnectorCapability,
  ConnectorCapabilityKind,
  ConnectorCursor,
  FactDisposition,
  FactKey,
  FetchCapabilityKind,
  FetchRequest,
  NormalizedBatch,
  NormalizedFact,
  ReconciledFact,
  ReconcilePlan,
} from "./connector-port";
export {
  assertCapability,
  reconcileFacts,
  supportsCapability,
} from "./connector-port";
export type {
  ReferenceAdapterHandle,
  ReferenceAdapterOptions,
  ReferenceEvent,
  ReferencePayload,
} from "./connector-reference-adapter";
export { createReferenceAdapter } from "./connector-reference-adapter";
export type {
  StatementAdapterHandle,
  StatementAdapterOptions,
} from "./connector-statement-adapter";
export {
  createStatementConnectorAdapter,
  statementContentToken,
} from "./connector-statement-adapter";
export type { StatementFactPayload } from "./connector-statement-normalize";
export {
  isStatementFactDubious,
  statementFactIdentity,
  statementFactsFromStatement,
  statementRowKey,
} from "./connector-statement-normalize";
export type {
  MonthlyAllocationDestination,
  MonthlyContributionAllocation,
} from "./contribution-allocation";
export {
  computeMonthlyContributionAllocation,
  isContributionMonthKey,
} from "./contribution-allocation";
export type {
  ComputeContributionAllowanceUsageInput,
  ContributionAllowance,
  ContributionAllowanceEntry,
  ContributionAllowanceUsage,
} from "./contribution-allowance";
export {
  assertContributionAllowanceInput,
  computeContributionAllowanceUsage,
} from "./contribution-allowance";
export type {
  ContributionCadence,
  ContributionOccurrence,
  ContributionOccurrenceReconciliation,
  ContributionOccurrenceState,
  ContributionPlan,
  ContributionProgressSummary,
  ContributionReconciliationProjection,
  IsoWeekday,
  PlannedContribution,
  PlannedContributionAmount,
  ProjectedContributionOccurrence,
} from "./contribution-plan";
export {
  assertContributionCadence,
  assertPlannedContributionInput,
  contributionOccurrenceId,
  contributionOccurrenceMoneyMinor,
  expandContributionPlan,
  expandPlannedContribution,
  parsePlannedContributionAmount,
  plannedMonthlyContributionsMinor,
  projectContributionReconciliation,
} from "./contribution-plan";
export type {
  DashboardShell,
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
export type {
  CollectDataQualitySignalsInput,
  DataQualityAffectedObject,
  DataQualityAffectedRef,
  DataQualityCategory,
  DataQualityConnectedSource,
  DataQualityPriceFreshness,
  DataQualityScopeContext,
  DataQualitySeverity,
  DataQualitySignal,
  DataQualitySourceFreshness,
  DataQualitySyncAttempt,
  DataQualityTrashedHolding,
} from "./data-quality-signals";
export {
  collectDataQualitySignals,
  compareDataQualitySignals,
  DATA_QUALITY_CATEGORY_ORDER,
  dataQualitySignalSortKey,
  isOverrideableSignalCode,
  OVERRIDEABLE_SIGNAL_CODES,
  PERSISTENT_SYNC_FAILURE_CODE,
  PERSISTENT_SYNC_FAILURE_THRESHOLD,
  SPARSE_SNAPSHOT_THRESHOLD,
  STALE_MANUAL_VALUE_CODE,
  STALE_MANUAL_VALUE_THRESHOLD_DAYS,
  sourceFreshnessStatus,
  TRASHED_WITH_BALANCE_CODE,
} from "./data-quality-signals";
export type { DateKey, Instant } from "./dates";
export { asDateKey, asInstant, daysBetween, MS_PER_DAY } from "./dates";
export type { AccruedInterestAtDate } from "./debt-accrual";
export { accruedInterestAtDate } from "./debt-accrual";
export type {
  DebtBalanceAnchor,
  DebtBalanceAtDateInput,
  EffectiveAmortizationPlan,
} from "./debt-balance";
export {
  debtAccrualAtDate,
  debtBalanceAtDate,
  effectiveAmortizationPlan,
  storedBalanceGovernsDebtFigure,
} from "./debt-balance";
export type { DecimalString } from "./decimal";
export {
  addUnits,
  averageUnitCost,
  compareUnits,
  divideUnits,
  formatUnits,
  isPositiveDecimal,
  minorToDecimal,
  multiplyToMinor,
  normalizeDecimal,
  proportionMinor,
  scaleDecimal,
  subtractUnits,
  UNITS_READBACK_DECIMALS,
} from "./decimal";
export type {
  StackedBandGeometry,
  StackedBarRect,
  StackedChartGeometry,
  StackedSeriesInput,
} from "./decomposition-chart";
export { buildStackedChartGeometry } from "./decomposition-chart";
export type {
  BuildMonthlyCloseBreakdownInput,
  DeltaBreakdownBandId,
  DeltaBreakdownBands,
  DeltaBreakdownPeriod,
  DeltaBreakdownWindowInput,
} from "./delta-breakdown";
export {
  buildMonthlyCloseBreakdownSeries,
  computeDeltaBreakdownWindow,
  periodShowsPayoutBand,
} from "./delta-breakdown";
export type { DomainResult, DomainViolation } from "./domain-result";
export type { DonutArcSegment, DonutGeometry } from "./donut";
export { donutArcSegments } from "./donut";
export type {
  DatedSnapshotHoldingRow,
  DebtDrillBand,
  DebtsDrilldownState,
  DrillBarRect,
  DrilldownInput,
  DrilldownKey,
  DrilldownState,
  DrillHoldingMultiple,
  DrillSparklineGeometry,
  GroupDrilldownState,
  HousingDrilldownState,
  LiquidDrilldownInput,
  LiquidDrilldownState,
  LiquidDrillTier,
  RestDrilldownState,
  RestDrillTier,
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
export {
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
  timeProportionalXs,
} from "./evolution-chart";
export type {
  AssembleExposureDriftHoldingsInput,
  AssembleExposureDriftHoldingsResult,
  ExposureDriftHoldingMeta,
  ExposureDriftPoint,
  ExposureDriftProjection,
  ExposureDriftProjectionInput,
} from "./exposure-drift-projection";
export {
  assembleExposureDriftHoldings,
  holdingAnnualReturnByIdForProjection,
  projectExposureDrift,
} from "./exposure-drift-projection";
export type {
  ExposureCatalogIdentitySource,
  GlobalExposureProfileIdentity,
  RawGlobalExposureProfileIdentityInput,
} from "./exposure-identity";
export {
  deriveExposureCatalogIdentity,
  exposureLookthroughKey,
  exposureProfileLookthroughMap,
  globalExposureProfileIdentityKey,
  INVESTMENT_PROFILE_INSTRUMENTS,
  isValidIsin,
  resolveGlobalExposureProfileIdentity,
} from "./exposure-identity";
export type {
  AssetClassResolution,
  ExposureAllocationSlice,
  ExposureBreakdowns,
  ExposureCoverage,
  ExposureDimensionResult,
  ExposureLookthrough,
  ExposureLookthroughHolding,
  ExposureLookthroughInput,
  ExposureProfile,
  ExposureSectorStyle,
} from "./exposure-lookthrough";
export {
  lookThroughExposure,
  resolveAssetClassBreakdown,
  validateImportedExposureProfile,
} from "./exposure-lookthrough";
export type {
  ExposureAssetClassBucket,
  ExposureDimension,
  ExposureGeographyBucket,
  ExposureSectorBucket,
} from "./exposure-taxonomy";
export {
  EXPOSURE_ASSET_CLASS_BUCKETS,
  EXPOSURE_ASSET_CLASS_LABELS,
  EXPOSURE_DEFENSIVE_SECTORS,
  EXPOSURE_GEOGRAPHY_BUCKETS,
  EXPOSURE_GEOGRAPHY_LABELS,
  EXPOSURE_SECTOR_BUCKETS,
  EXPOSURE_SECTOR_LABELS,
  sectorStyleSplit,
} from "./exposure-taxonomy";
export type {
  CalculateFireForScopeOptions,
  FireContext,
  FireExcludedAsset,
  FireExclusionReason,
  FireResult,
  FireScopeConfig,
  ProjectFireFromContextInput,
  ScopeFireResult,
} from "./fire";
export {
  calculateFire,
  calculateFireForScope,
  fireCountsImmobilizedCapital,
  fireReservationHorizon,
  isFireEligibleAsset,
  isManualFireReturn,
  projectFireFromContext,
  withRate,
} from "./fire";
export type {
  FireAchievement,
  FireAchievementInput,
  FireAchievementLevel,
} from "./fire-achievement";
export { fireAchievement } from "./fire-achievement";
export type { FireAssumptionOverrides } from "./fire-assumption-preview";
export { previewFireWithAssumptions } from "./fire-assumption-preview";
export type { FireCapitalSide, FireCapitalSplit } from "./fire-capital-split";
export { fireDrawsFromTier, splitFireCapital } from "./fire-capital-split";
export type { FireCoastArrival } from "./fire-coast-arrival";
export { fireCoastArrival } from "./fire-coast-arrival";
export type { BirthDate, FireAgeSource } from "./fire-current-age";
export {
  ageOnDate,
  parseBirthYear,
  parseCalendarMonth,
  scopeAgeSource,
  scopeCurrentAge,
  withDerivedCurrentAges,
} from "./fire-current-age";
export type {
  AssembleFireEligiblePoolInput,
  FireEligiblePool,
} from "./fire-eligible-pool";
export { assembleFireEligiblePool } from "./fire-eligible-pool";
export type { FireLevel, FireLevelKey, FireLevelsInput } from "./fire-levels";
export { fireLevels } from "./fire-levels";
export type { FireGrowthAssumption } from "./fire-plan-projection";
// `projectFireWithContributionPlan` (the contribution-plan engine) is an internal
// dispatch target of `projectFireFromContext` (#1122); only the shared
// contribution-stream seam is public.
export { contributionMoneyByProjectionYear } from "./fire-plan-projection";
export type {
  FireProjection,
  FireScenario,
  FireScenarioLabel,
  FireTrajectoryPoint,
} from "./fire-projection";
// `projectFire` (the scalar engine) is intentionally internal (#1122): callers
// project through `projectFireFromContext`, the single door.
export { DEFAULT_MAX_YEARS, fractionalFireYear } from "./fire-projection";
export type {
  AppliedRentReturn,
  FireRentReturnReport,
  RentDerivedReturn,
  RentRealReturns,
  RentReturnNotice,
  RentReturnNoticeReason,
} from "./fire-rent-return";
export {
  annualizedMinor,
  deriveRentRealReturns,
  isScheduleLiveOn,
} from "./fire-rent-return";
export type {
  FireRetirementPlan,
  FireRetirementProfile,
  FireRetirementProfileState,
  FireRetirementSignal,
} from "./fire-retirement-profile";
export {
  fireRetirementProfile,
  ORDINARY_RETIREMENT_AGE_DEFAULT,
  ordinaryRetirementAgeForFire,
} from "./fire-retirement-profile";
export type {
  FireRetirementReadout,
  FireRetirementReadoutInput,
} from "./fire-retirement-readout";
export { fireRetirementReadout } from "./fire-retirement-readout";
export type {
  AssetRateOverride,
  EligibleTier,
  FireReturnMix,
  FireReturnMixRow,
} from "./fire-return";
export {
  effectiveRealReturn,
  fireReturnMix,
  TIER_REAL_RETURN_DEFAULTS,
} from "./fire-return";
export { monthlySavingsCapacityForFire } from "./fire-savings-capacity";
export type {
  FireDepletionAbsence,
  FireSustainableSpending,
  FireSustainableSpendingDepletion,
  FireSustainableSpendingPart,
  FireSustainableSpendingSides,
} from "./fire-sustainable-spending";
export { fireSustainableSpending } from "./fire-sustainable-spending";
export type {
  FxAggregation,
  FxConversionResult,
  FxExcludedHolding,
  FxRatePoint,
  FxRateSnapshot,
  FxUnconvertibleReason,
  MoneyConverter,
} from "./fx";
export {
  BASE_CURRENCY,
  createFxRateSnapshot,
  createMoneyConverter,
  FX_CARRY_FORWARD_DAYS,
  resolveToBaseCurrency,
} from "./fx";
export type {
  CreateGlobalExposureProfileInput,
  GlobalExposureAssetClassBucket,
  GlobalExposureGeographyBucket,
  GlobalExposureProfile,
  GlobalExposureProfileBreakdowns,
  GlobalExposureProfileContentInput,
  GlobalExposureSectorBucket,
  UpdateGlobalExposureProfileInput,
} from "./global-exposure-profile";
export {
  createValidatedGlobalExposureProfileInput,
  GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS,
  validateGlobalExposureProfileContent,
} from "./global-exposure-profile";
export type { GoalFireDelay, GoalFireDelayInput } from "./goal-fire-delay";
export { goalFireDelay } from "./goal-fire-delay";
export type { Goal, GoalPriority, GoalReservationInput } from "./goals";
export {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  totalGoalReservationMinor,
} from "./goals";
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
export {
  amortizationPaymentDatesUpTo,
  buildSnapshotAtDate,
  globalHoldingValueAtDate,
  historicalCapturedAt,
  rebaselineChainPaymentDatesUpTo,
  recalculateSnapshotForAsset,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
} from "./historical-snapshot";
export type {
  HoldingBenchmarkComparison,
  HoldingBenchmarkComparisonResult,
  HoldingBenchmarkUnavailableReason,
} from "./holding-benchmark-comparison";
export {
  compareHoldingToBenchmark,
  holdingBenchmarkComparison,
  holdingTwrIndexSeries,
} from "./holding-benchmark-comparison";
export type {
  MatchCandidate,
  MatchCandidateRow,
  MatchConfidence,
  MatchDecision,
  MatchKey,
  MatchPortfolioHolding,
  RowMatch,
} from "./holding-matcher";
export {
  countKeyClaimants,
  discardRow,
  matchHoldings,
  reassignToCandidate,
  reassignToNew,
} from "./holding-matcher";
export {
  isValueUpdateEligible,
  keepsAnOperationLedger,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "./holding-method";
export type { HoldingTrashImpact } from "./holding-trash-impact";
export { holdingTrashImpact } from "./holding-trash-impact";
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
export type {
  HousingValuationAnchor,
  ValueHousingAtDateInput,
} from "./housing-valuation";
export { valueHousingAtDate } from "./housing-valuation";
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
export type {
  InstrumentIdentityDeclaration,
  InstrumentIdentityFillResolution,
  InstrumentIdentityHolding,
  InstrumentIdentityPatch,
} from "./instrument-identity-fill";
export { resolveInstrumentIdentityFill } from "./instrument-identity-fill";
export type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  OperationCapture,
  OperationKind,
  OperationSource,
  PositionSummary,
} from "./investment-types";
export type {
  DeriveInvestmentValuationInput,
  InvestmentPriceSource,
  InvestmentValuation,
  SelectedInvestmentPrice,
} from "./investment-valuation";
export {
  assertManualValuationAllowed,
  assertNotConnectedValuation,
  assertNotInvestmentAsset,
  checkManualValuationViolation,
  deriveInvestmentValuation,
  selectInvestmentPrice,
} from "./investment-valuation";
export { LIQUIDITY_LADDER, LIQUIDITY_TIER_LABELS } from "./liquidity-ladder";
export { isIsinShaped } from "./matching-keys";
export type { CurrencyCode, MoneyMinor } from "./money";
export {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  formatMoneyMinorExact,
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
export type {
  MeasureMonthlySavingsOptions,
  MonthlySavingsMeasurement,
  MonthlySavingsSuggestion,
} from "./monthly-savings";
export { measureMonthlySavings, suggestMonthlySavingsCapacity } from "./monthly-savings";
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
  PassiveIncomeLens,
  ScopePassiveIncomeInput,
} from "./objetivos-passive-income";
export { scopePassiveIncome } from "./objetivos-passive-income";
export type {
  CaptureCurrency,
  CapturedFigures,
  ConvertedFigures,
} from "./operation-currency";
export {
  CAPTURE_CURRENCIES,
  CONVERTED_PRICE_DECIMALS,
  convertCapturedFigures,
  convertOperationToBaseCurrency,
  isCaptureCurrency,
  lastCapturedCurrency,
  mixedCurrencyWarning,
} from "./operation-currency";
export type { TransferFlowPolicy } from "./operation-flow";
export { signedInvestedMinor, unhandledOperationKind } from "./operation-flow";
export type {
  DatedAmount,
  DerivedPayout,
  PassiveIncomeWindow,
  Payout,
  PayoutCadence,
  PayoutSchedule,
} from "./payouts";
export {
  collectHoldingPayouts,
  deriveScheduleOccurrences,
  passiveIncomeTrailing,
} from "./payouts";
export type {
  PortfolioGroup,
  PortfolioGroupKey,
  UnifiedHolding,
} from "./portfolio-grouping";
export { groupPortfolio, PORTFOLIO_GROUP_KEYS } from "./portfolio-grouping";
export type {
  AssetsSection,
  LiabilitiesSection,
  PortfolioProjection,
  PortfolioProjectionInput,
  PortfolioSection,
  PriceRefreshMeta,
  ProjectedAssetRow,
  ProjectedLiabilityRow,
  RowOwnership,
} from "./portfolio-projection";
export { projectPortfolio } from "./portfolio-projection";
export {
  compareInvestmentOperations,
  createInvestmentOperation,
  createInvestmentOperationSafe,
  derivePosition,
  isTransferKind,
  latestOperationPrice,
  netUnitsByAsset,
  netUnitsFromOperations,
  operationsUpTo,
} from "./positions";
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
  AssetPrice,
  InvestmentPriceProvider,
  PriceFreshnessState,
  PriceSource,
} from "./prices";
export {
  defaultInvestmentPriceProvider,
  getPriceFreshness,
  INVESTMENT_PRICE_PROVIDERS,
  isInvestmentPriceProvider,
  isPriceStale,
  isProviderSymbolShaped,
  isRetiredInvestmentPriceProvider,
  PRICE_TTL_DAYS,
  RETIRED_INVESTMENT_PRICE_PROVIDERS,
  SELECTABLE_INVESTMENT_PRICE_PROVIDERS,
  selectStalePrices,
  unitPriceMajorByHoldingId,
  usableCachedPrice,
} from "./prices";
export type {
  BenchmarkSeriesAvailability,
  BenchmarkSeriesPricePoint,
  BenchmarkSeriesReader,
  ExposureCatalogAvailability,
  ExposureCatalogReader,
  ReferenceDataReaders,
  ReferenceDataUnavailableReason,
} from "./reference-data";
export type {
  DatedCashflow,
  DatedPayout,
  HoldingReturnsInput,
  HoldingTwrInput,
  IrrReason,
  IrrResult,
  MonthlyCloseSnapshotRow,
  MonthlyCloseValue,
  PortfolioHolding,
  PortfolioReturnsInput,
  PortfolioTwrInput,
  SimpleGain,
  TimeWeightedReturnInput,
  TwrCashflow,
  TwrReason,
  TwrResult,
} from "./returns";
export {
  holdingIrr,
  holdingTwr,
  monthlyCloseValuesFromSnapshotRows,
  operationCashflows,
  operationTwrCashflows,
  portfolioIrr,
  portfolioSimpleGain,
  portfolioTwr,
  simpleGain,
  simpleGainFromCashflows,
  timeWeightedReturn,
  xirr,
} from "./returns";
export type {
  AssetClassReturns,
  AssetClassReturnsHolding,
  ReturnsByAssetClass,
  ReturnsByAssetClassInput,
} from "./returns-by-class";
export {
  OTHER_ASSET_CLASS_KEY,
  returnsByAssetClass,
  UNCLASSIFIED_ASSET_CLASS_KEY,
} from "./returns-by-class";
export type {
  AssetClassReturnsView,
  AssetClassReturnsViewResult,
  HoldingReturnsView,
  HoldingReturnsViewInput,
  InvestmentReturnsContext,
  ReturnsKind,
} from "./returns-display";
export {
  APPRECIATING_CAVEAT,
  buildHoldingReturnsView,
  buildPortfolioReturnsView,
  CLASS_ATTRIBUTION_CAVEAT,
  investmentReturnsById,
  MARKET_CAVEAT,
  MARKET_PAYOUTS_CAVEAT,
  portfolioReturnsView,
  resolveHoldingAnnualReturnForProjection,
  returnsByAssetClassView,
  returnsKindForInstrument,
} from "./returns-display";
export type {
  AssessSavingsCoherenceInput,
  SavingsCoherence,
  SavingsCoherenceState,
} from "./savings-coherence";
export {
  assessSavingsCoherence,
  describeSavingsDivergence,
  MEASURED_SAVINGS_MIN_MONTHS,
  MEASURED_SAVINGS_WINDOW_MONTHS,
  SAVINGS_DIVERGENCE_MIN_ABSOLUTE_MINOR,
  SAVINGS_DIVERGENCE_MIN_RATIO,
  scopeSavingsCoherence,
} from "./savings-coherence";
export type { ScopeOption, ScopeType } from "./scope";
export { findScopeMemberIds, listScopeOptions, resolveScopeMemberIds } from "./scope";
export type { ScopedHolding } from "./scope-allocation";
export { allocateScopedHolding } from "./scope-allocation";
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
export type { SnapshotPolicyEntry } from "./snapshot-policy";
export {
  deriveConfirmedMonthlyCloseIds,
  deriveMonthlyCloses,
  findTodaySnapshotId,
} from "./snapshot-policy";
export type {
  PlanSnapshotPriceCorrectionInput,
  PlanSnapshotPriceCorrectionResult,
  SnapshotPriceCorrectionPoint,
  SnapshotPriceCorrectionRejectReason,
} from "./snapshot-price-correction";
export {
  planSnapshotPriceCorrection,
  snapshotPriceCorrectionErrorMessage,
} from "./snapshot-price-correction";
export type {
  CreateNetWorthSnapshotInput,
  FramedDelta,
  FramedSnapshotDeltas,
  NetWorthSnapshot,
  SnapshotDeltas,
  SnapshotWarningInputs,
  ValuedNetWorthSnapshot,
} from "./snapshot-types";
export {
  calculateSnapshotDeltas,
  captureNetWorthSnapshot,
  captureValuedNetWorthSnapshot,
  createNetWorthSnapshot,
  deriveFramedSnapshotDeltas,
} from "./snapshot-types";
export type {
  ColumnResolution,
  StatementBrokerAdapter,
  StatementRowOutcome,
  StatementRowResult,
} from "./statement-broker-adapter";
export { getStatementBrokerAdapter, isStatementBroker } from "./statement-broker-adapter";
export type { BrokerTransactionsStatementResult } from "./statement-from-broker-transactions";
export { statementFromBrokerTransactions } from "./statement-from-broker-transactions";
export type {
  MatchedStatementFund,
  NewStatementFund,
  StatementFundClaimant,
  StatementFundGroup,
  StatementFundSelection,
  StatementImportBucket,
  StatementImportPlan,
  StatementImportPlanFund,
  StatementNewInvestmentSelection,
  StatementPortfolioInvestment,
} from "./statement-import-plan";
export {
  buildStatementImportPlan,
  findStatementTypeConflict,
  findUnresolvedStatementChoice,
  groupStatementRowsByIsin,
  resolveStatementImportBuckets,
} from "./statement-import-plan";
export type { PerHoldingStatementIsinGuard, StatementIsinGuard } from "./statement-isin";
export {
  resolvePerHoldingStatementIsinGuard,
  resolveStatementIsinGuard,
} from "./statement-isin";
export type {
  StatementAnomaly,
  StatementMergePlan,
  StatementOverwrite,
} from "./statement-merge";
export { planStatementMerge } from "./statement-merge";
export type {
  ParsedStatement,
  ParsedStatementRow,
  ParseStatementResult,
  SkippedStatementRow,
  StatementBroker,
} from "./statement-parse";
export {
  parseStatement,
  parseStatementWithAdapter,
  statementHeaderMatches,
} from "./statement-parse";
export type {
  ExternalTransferInIntent,
  TransferIntent,
  TransferOrigin,
  TransferPair,
  TransferPortion,
} from "./transfer-plan";
export { planExternalTransferIn, planTransfer } from "./transfer-plan";
export type { InterpolateOrStepInput, ValuationCadence } from "./valuation-cadence";
export {
  cadenceOrDefault,
  interpolateOrStep,
  sampleDateForCadence,
} from "./valuation-cadence";
export type { ManualValuePoint } from "./value-history";
export { lastKnownValueAtDate, lastManualValueUpdateDateKey } from "./value-history";
export type { ValueOnlyOpening } from "./value-only-opening";
export {
  detectValueOnlyOpening,
  VALUE_ONLY_ACK_LABEL,
  valueOnlySymbolFormNotice,
  valueOnlySymbolGuardMessage,
} from "./value-only-opening";
export type {
  CollectWarningsOptions,
  DomainWarning,
  WarningOverride,
  WarningSeverity,
} from "./warnings";
export { collectWarnings, isClosedPosition, unitsReadAsClosed } from "./warnings";
export type {
  ExportedAmortizationPlan,
  ExportedAsset,
  ExportedBalanceAnchor,
  ExportedBalanceRebaseline,
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
  checkSinglePrimaryResidence,
  createLiability,
  createLiabilitySafe,
  createManualAsset,
  createManualAssetSafe,
  createWorkspace,
} from "./workspace-types";
