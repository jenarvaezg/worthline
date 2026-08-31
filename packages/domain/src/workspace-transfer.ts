/**
 * Workspace export/import file contract (ADR 0010) — the ONE source.
 *
 * A `WorkspaceExport` is the versioned JSON document that captures an entire
 * workspace: live state, frozen snapshot history, the papelera, and the price
 * cache. It is the manual stand-in for backup/sync in an app with no cloud.
 * The audit log is deliberately not a section.
 *
 * The document is untrusted input at a system boundary — it may be produced by
 * an external script, not just by the app — so importers must validate it
 * (structure plus domain invariants) before any write. A `version` mismatch is
 * rejected outright: there is intentionally no format-migration ladder.
 *
 * **The schemas below ARE the contract** (#1602). Every `Exported*` type is
 * derived from its schema with `z.output`, so a field is declared once and the
 * validator can never fall behind the type. Before #1602 this module held a
 * parallel tree of hand-written interfaces and `parseWorkspaceExport` bridged
 * the two with a bare `as WorkspaceExport`; the drift that hid behind that cast
 * silently refused a housing rung (ADR 0022), the `coingecko` price provider,
 * the `binance` price source, and dropped four FIRE declarations (#1428, #1460)
 * on every round-trip.
 *
 * Sections that carry a type the domain already owns (`Member`, `Payout`,
 * `NetWorthSnapshot`, …) are anchored to it with `reproduces` and their
 * vocabularies with `vocabularyOf`, both from `schema-anchor` — which documents
 * exactly what each anchor does and does not promise. The domain module stays the
 * source of those types; this module is the source of the document's own shapes.
 *
 * `parseWorkspaceExport` (in `workspace-transfer-parse`) validates.
 * `serializeWorkspaceExport` seals the version. Nobody writes the shape twice.
 */

import { z } from "zod";
import type { EarlyRepaymentMode } from "./amortization";
import type {
  CoinPosition,
  DistributiveOmit,
  SourceAdapter,
  SourcePosition,
  TokenPosition,
} from "./connected-source";
import type { ContributionAllowance } from "./contribution-allowance";
import type {
  ContributionOccurrenceState,
  ContributionPlan,
  IsoWeekday,
  PlannedContribution,
} from "./contribution-plan";
import type { CostBasisGrade } from "./cost-basis-grade";
import { asInstant } from "./dates";
import type { FireScopeConfig } from "./fire";
import type { FireRetirementPlan } from "./fire-retirement-profile";
import type { TrashExit } from "./holding-trash-exit";
import type { ValuationMethod } from "./holding-valuation";
import type { Instrument } from "./instrument-catalog";
import type {
  InvestmentOperation,
  OperationKind,
  OperationSource,
} from "./investment-types";
import type { LiquidityTier } from "./liquidity-ladder";
import { LIQUIDITY_LADDER } from "./liquidity-ladder";
import type { ManagedPortfolio } from "./managed-portfolio";
import type { ManagedPortfolioWitness } from "./managed-portfolio-reconciliation";
import type { CurrencyCode, MoneyMinor } from "./money";
import type { Payout, PayoutCadence, PayoutSchedule } from "./payouts";
import type {
  AssetPrice,
  InvestmentPriceProvider,
  PriceFreshnessState,
  PriceSource,
} from "./prices";
import { INVESTMENT_PRICE_PROVIDERS } from "./prices";
import { coversUnion, reproduces, vocabularyOf } from "./schema-anchor";
import type {
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  SnapshotPositionRow,
} from "./snapshot-holdings";
import type { NetWorthSnapshot } from "./snapshot-types";
import type { ValuationCadence } from "./valuation-cadence";
import type { DomainWarning, WarningOverride, WarningSeverity } from "./warnings";
import type {
  AssetType,
  DebtModel,
  LiabilityType,
  Member,
  MemberGroup,
  OwnershipShare,
  RiskTolerance,
  WorkspaceMode,
} from "./workspace-types";

/**
 * Bumped to 2 for the full-holding-model format (ADR 0015, #155): the v1 shape
 * silently dropped every dated structural fact (appreciation rate, valuation
 * anchors, debt model, amortization plan, rate revisions, early repayments,
 * balance anchors). No production v1 exports exist, so v1 is abandoned with no
 * converter — version 1 is rejected outright like any other mismatch.
 *
 * Bumped to 3 for the global exposure-profile catalog (PRD #711 S6, #942): v3
 * backups no longer carry or restore workspace-local exposure profiles — the
 * global catalog is the sole source. v2 is rejected outright like any other
 * mismatch.
 *
 * NOT bumped by #1602: that slice widened the validator to accept documents the
 * contract already promised (a housing rung, `coingecko`, `binance`) and to stop
 * dropping declarations it was already carrying. Nothing about a v3 file changed,
 * so a bump would only refuse the backups already on users' disks.
 */
export const EXPORT_VERSION = 3;

// ── Primitives ──────────────────────────────────────────────────────────────

const nonEmptyString = z.string().min(1);

/**
 * Always EUR in the MVP — anything else is rejected by the import invariants.
 *
 * Anchored by annotation rather than `reproduces`: the anchor's key check is
 * meaningless for a type that is not an object, so the annotation says the same
 * thing with less ceremony. Same for `isoWeekdaySchema` below.
 */
const currencySchema: z.ZodType<CurrencyCode, unknown> = nonEmptyString;

const moneyMinorSchema = reproduces<MoneyMinor>()(
  z.object({
    // Integer minor units — the assertMinorInteger invariant at the file boundary.
    amountMinor: z.number().int(),
    currency: currencySchema,
  }),
);

const ownershipShareSchema = reproduces<OwnershipShare>()(
  z.object({
    memberId: nonEmptyString,
    shareBps: z.number().int().positive(),
  }),
);

// ── Vocabularies (exact against their domain unions) ────────────────────────

/** Every rung of the ladder, `housing` included (ADR 0022) — from its one home. */
const liquidityTierSchema = z.enum(LIQUIDITY_LADDER);

/** Retired providers included: the vocabulary of the DATA, not of what a user may pick. */
const investmentPriceProviderSchema = z.enum(INVESTMENT_PRICE_PROVIDERS);

const workspaceModeSchema = vocabularyOf<WorkspaceMode>()(["individual", "household"]);
const riskToleranceSchema = vocabularyOf<RiskTolerance>()([
  "conservative",
  "moderate",
  "aggressive",
]);
const assetTypeSchema = vocabularyOf<AssetType>()([
  "cash",
  "manual",
  "real_estate",
  "investment",
]);
const liabilityTypeSchema = vocabularyOf<LiabilityType>()(["mortgage", "debt"]);
const debtModelSchema = vocabularyOf<DebtModel>()([
  "amortizable",
  "revolving",
  "informal",
]);
const instrumentSchema = vocabularyOf<Instrument>()([
  "current_account",
  "term_deposit",
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
  "precious_metal",
  "vehicle",
  "property",
  "mortgage",
  "loan",
  "credit_card",
  "coin_collection",
  "other",
]);
const valuationMethodSchema = vocabularyOf<ValuationMethod>()([
  "stored",
  "derived",
  "appreciating",
  "amortized",
  "anchored",
]);
const valuationCadenceSchema = vocabularyOf<ValuationCadence>()(["step", "interpolated"]);
const earlyRepaymentModeSchema = vocabularyOf<EarlyRepaymentMode>()([
  "reduce-payment",
  "reduce-term",
]);
const trashExitSchema = vocabularyOf<TrashExit>()(["sold", "transferred", "mis_entry"]);
const operationKindSchema = vocabularyOf<OperationKind>()([
  "buy",
  "sell",
  "transfer_out",
  "transfer_in",
]);
const costBasisGradeSchema = vocabularyOf<CostBasisGrade>()([
  "declared_cost",
  "value_only",
]);
const operationSourceSchema = vocabularyOf<OperationSource>()([
  "manual",
  "opening",
  "statement",
  "connected",
  "agent",
]);
const priceSourceSchema = vocabularyOf<PriceSource>()([
  "manual",
  "ecb",
  "coingecko",
  "stooq",
  "yahoo",
  "finect",
  "numista",
  "binance",
]);
const priceFreshnessStateSchema = vocabularyOf<PriceFreshnessState>()([
  "fresh",
  "stale",
  "failed",
  "manual",
]);
const payoutCadenceSchema = vocabularyOf<PayoutCadence>()([
  "weekly",
  "monthly",
  "quarterly",
  "annual",
]);
const warningEntityTypeSchema = vocabularyOf<DomainWarning["entityType"]>()([
  "asset",
  "liability",
]);
const warningSeveritySchema = vocabularyOf<WarningSeverity>()([
  "blocking",
  "overrideable",
]);
const snapshotHoldingKindSchema = vocabularyOf<SnapshotHoldingKind>()([
  "asset",
  "liability",
]);
const sourceAdapterSchema = vocabularyOf<SourceAdapter>()(["numista", "binance"]);
const fireRetirementPlanSchema = vocabularyOf<FireRetirementPlan>()([
  "ordinary",
  "early",
]);
const contributionOccurrenceStateSchema = vocabularyOf<ContributionOccurrenceState>()([
  "open",
  "fulfilled",
  "skipped",
]);

// ── Members, groups and workspace configuration ─────────────────────────────

const workspaceConfigSchema = z.object({
  mode: workspaceModeSchema,
  /** Always EUR in the MVP — anything else is rejected on import. */
  baseCurrency: currencySchema,
});

/** Workspace-level configuration carried by the file. */
export type ExportedWorkspaceConfig = z.output<typeof workspaceConfigSchema>;

const memberSchema = reproduces<Member>()(
  z.object({
    id: nonEmptyString,
    name: nonEmptyString,
    disabledAt: nonEmptyString.optional(),
    // Member profile (PRD #421, #423) — optional so pre-profile exports still parse.
    // `birthMonth` (1-12, #1415) sharpens the derived FIRE age; absent = year only.
    birthYear: z.number().int().optional(),
    birthMonth: z.number().int().min(1).max(12).optional(),
    fiscalCountry: nonEmptyString.optional(),
    riskTolerance: riskToleranceSchema.optional(),
  }),
);

const groupSchema = reproduces<MemberGroup>()(
  z.object({
    id: nonEmptyString,
    name: nonEmptyString,
    memberIds: z.array(nonEmptyString),
  }),
);

// ── Structural facts (ADR 0015, #155): the full holding model ───────────────

const valuationAnchorSchema = z.object({
  id: nonEmptyString,
  /** Integer minor units. TOTAL when adjustsPriorCurve, INCREMENT otherwise. */
  valueMinor: z.number().int(),
  /** YYYY-MM-DD. */
  valuationDate: nonEmptyString,
  /** True for a market appraisal (total truth), false for an improvement. */
  adjustsPriorCurve: z.boolean(),
});

/**
 * One housing valuation anchor (ADR 0015, #155): a market appraisal (total
 * truth) or an improvement (increment) layered on the appreciation curve. Its
 * id is carried so a restore preserves it verbatim.
 */
export type ExportedValuationAnchor = z.output<typeof valuationAnchorSchema>;

const interestRateRevisionSchema = z.object({
  id: nonEmptyString,
  /** YYYY-MM-DD the new rate takes effect from. */
  revisionDate: nonEmptyString,
  /** Decimal-string annual rate, e.g. "0.031". */
  newAnnualInterestRate: nonEmptyString,
});

/** A scheduled interest-rate change on an amortization plan (ADR 0015, #155). */
export type ExportedInterestRateRevision = z.output<typeof interestRateRevisionSchema>;

const earlyRepaymentSchema = z.object({
  id: nonEmptyString,
  /** YYYY-MM-DD the repayment is made. */
  repaymentDate: nonEmptyString,
  /** Principal repaid, integer minor units. */
  amountMinor: z.number().int(),
  /** reduce-payment keeps the term; reduce-term keeps the cuota. */
  mode: earlyRepaymentModeSchema,
});

/** A lump-sum early repayment against an amortization plan (ADR 0015, #155). */
export type ExportedEarlyRepayment = z.output<typeof earlyRepaymentSchema>;

const balanceRebaselineSchema = z.object({
  id: nonEmptyString,
  baselineDate: nonEmptyString,
  outstandingBalanceMinor: z.number().int(),
  endDate: nonEmptyString,
  nextPaymentDate: nonEmptyString,
  annualInterestRate: nonEmptyString,
  monthlyPaymentMinor: z.number().int(),
  inputMode: z.enum(["annual-rate", "monthly-payment"]),
  startsAtBaseline: z.boolean(),
});

/** A current-state balance re-baseline on an amortizable liability (ADR 0056). */
export type ExportedBalanceRebaseline = z.output<typeof balanceRebaselineSchema>;

const amortizationPlanSchema = z.object({
  id: nonEmptyString,
  /** Initial borrowed capital, integer minor units. */
  initialCapitalMinor: z.number().int(),
  /** Decimal-string annual interest rate, e.g. "0.025". */
  annualInterestRate: nonEmptyString,
  /** Loan term in whole months (payments counted from the first payment). */
  termMonths: z.number().int().positive(),
  /** Disbursement date (firma / devengo), YYYY-MM-DD (ADR 0019). */
  disbursementDate: nonEmptyString,
  /** First-payment date, YYYY-MM-DD (ADR 0019). */
  firstPaymentDate: nonEmptyString,
  /** Optional descriptive metadata (ADR 0056, #677): the debt's true original
   *  signing date, for a plan created by current-state entry. Never read by
   *  the balance curve. */
  originalSigningDate: nonEmptyString.optional(),
  interestRateRevisions: z.array(interestRateRevisionSchema).default([]),
  earlyRepayments: z.array(earlyRepaymentSchema).default([]),
});

/**
 * The French-amortization plan of an amortizable debt (ADR 0015, #155): its
 * declared conditions plus the dated facts that reshape its schedule — rate
 * revisions and early repayments — which hang off the plan by id.
 */
export type ExportedAmortizationPlan = z.output<typeof amortizationPlanSchema>;

const balanceAnchorSchema = z.object({
  id: nonEmptyString,
  /** Total owed on that date, integer minor units (interest already included). */
  balanceMinor: z.number().int(),
  /** YYYY-MM-DD the balance applies on. */
  anchorDate: nonEmptyString,
});

/** A declared balance of a revolving/informal liability on a date (ADR 0015, #155). */
export type ExportedBalanceAnchor = z.output<typeof balanceAnchorSchema>;

// ── Holdings ────────────────────────────────────────────────────────────────

const investmentMetaSchema = z.object({
  unitSymbol: nonEmptyString.optional(),
  isin: nonEmptyString.optional(),
  priceProvider: investmentPriceProviderSchema.optional(),
  providerSymbol: nonEmptyString.optional(),
  manualPricePerUnit: nonEmptyString.optional(),
  manualPricedAt: nonEmptyString.optional(),
});

/** Investment metadata attached to an asset of type "investment". */
export type ExportedInvestmentMeta = z.output<typeof investmentMetaSchema>;

const assetSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  type: assetTypeSchema,
  currency: currencySchema,
  currentValue: moneyMinorSchema.optional(),
  liquidityTier: liquidityTierSchema,
  isPrimaryResidence: z.boolean().optional(),
  /** What the asset is (ADR 0014, #149); derived from type on import when absent. */
  instrument: instrumentSchema.optional(),
  /** How the asset's value evolves (ADR 0014/0015); derived from type on import when absent. */
  valuationMethod: valuationMethodSchema.optional(),
  /** Valuation cadence (ADR 0031); `step` default, so absent round-trips as step. */
  valuationCadence: valuationCadenceSchema.optional(),
  /** Decimal-string annual appreciation rate (e.g. "0.03"); only meaningful for real estate. */
  annualAppreciationRate: nonEmptyString.optional(),
  /** Housing valuation anchors (market appraisals + improvements); ordered by date. */
  valuationAnchors: z.array(valuationAnchorSchema).optional(),
  /** The connected source this asset materializes a rung of (ADR 0016/0021, #248);
   *  absent for a hand-maintained holding. Carried so a multi-rung source's link
   *  round-trips (the source row in `connectedSources` names only the primary asset). */
  connectedSourceId: nonEmptyString.optional(),
  ownership: z.array(ownershipShareSchema),
  investment: investmentMetaSchema.optional(),
  deletedAt: nonEmptyString.optional(),
  /**
   * How the holding left the book, when the Papelera's door recorded it (#1549):
   * sold | transferred | mis_entry. Appears only inside the trash section, next to
   * `deletedAt`, and only when the door had something to record.
   */
  trashExit: trashExitSchema.optional(),
});

/**
 * One asset in the file. Hand-valued kinds carry `currentValue`; investments
 * never do — their value is derived from operations and prices (ADR 0006), so
 * a hand-valued investment is rejected on import. `deletedAt` appears only on
 * entries inside the trash section.
 *
 * Structural facts (ADR 0015, #155) — `valuationMethod`, `annualAppreciationRate`,
 * and `valuationAnchors` — are carried so an appreciating property survives a
 * round-trip with its revaluation curve intact instead of flattening to a line.
 */
export type ExportedAsset = z.output<typeof assetSchema>;

const liabilitySchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  type: liabilityTypeSchema,
  currency: currencySchema,
  currentBalance: moneyMinorSchema,
  /** What the liability is (ADR 0014, #149); derived from type on import when absent. */
  instrument: instrumentSchema.optional(),
  /** How the liability's balance evolves (ADR 0014/0015); derived from debt model on import when absent. */
  valuationMethod: valuationMethodSchema.optional(),
  /** Valuation cadence (ADR 0031); `step` default, so absent round-trips as step. */
  valuationCadence: valuationCadenceSchema.optional(),
  /** How the liability is modelled for historical reconstruction; null/absent means manual balance. */
  debtModel: debtModelSchema.optional(),
  /** The amortization plan (with its revisions + early repayments) when debtModel is amortizable. */
  amortizationPlan: amortizationPlanSchema.optional(),
  /** Current-state re-baselines for an amortizable debt; ordered by baseline date. */
  balanceRebaselines: z.array(balanceRebaselineSchema).optional(),
  /** Declared balance anchors when debtModel is revolving/informal; ordered by date. */
  balanceAnchors: z.array(balanceAnchorSchema).optional(),
  ownership: z.array(ownershipShareSchema),
  associatedAssetId: nonEmptyString.optional(),
  deletedAt: nonEmptyString.optional(),
});

/**
 * One liability in the file. `deletedAt` appears only inside the trash section.
 *
 * Structural facts (ADR 0015, #155) — `valuationMethod`, `debtModel`,
 * `amortizationPlan` (with its revisions + early repayments), and
 * `balanceAnchors` — are carried so an amortizing debt survives a round-trip
 * with its schedule intact instead of flattening to a line.
 */
export type ExportedLiability = z.output<typeof liabilitySchema>;

const trashSchema = z.object({
  assets: z.array(assetSchema).default([]),
  liabilities: z.array(liabilitySchema).default([]),
});

/** The papelera: soft-deleted holdings awaiting restore or hard delete. */
export type ExportedTrash = z.output<typeof trashSchema>;

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * The pre-conversion apunte (#1401). Absent on a euro operation; when present all
 * four fields come together, which is what makes the conversion auditable after an
 * export → import round-trip instead of silently re-derived.
 */
const operationCaptureSchema = z.object({
  currency: currencySchema,
  pricePerUnit: nonEmptyString,
  feesMinor: z.number().int(),
  eurPerUnit: z.number().positive(),
});

const operationSchema = reproduces<InvestmentOperation>()(
  z.object({
    id: nonEmptyString,
    assetId: nonEmptyString,
    /** The four kinds of the ledger, traspaso halves included (#1393). */
    kind: operationKindSchema,
    executedAt: nonEmptyString,
    occurredAt: nonEmptyString
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
          Number.isFinite(Date.parse(value)),
        "occurredAt debe ser un instante UTC",
      )
      .transform(asInstant)
      .optional(),
    units: nonEmptyString,
    pricePerUnit: nonEmptyString,
    currency: currencySchema,
    feesMinor: z.number().int(),
    source: operationSourceSchema.default("manual"),
    capture: operationCaptureSchema.optional(),
    /** Both halves of a traspaso carry it; nothing else does (#1393). */
    transferId: nonEmptyString.optional(),
    /** The inherited acquisition cost, on the `transfer_in` half only (#1393). */
    transferCostMinor: z.number().int().nonnegative().optional(),
    /**
     * How honest this row's price is as a cost (#1505). Absent in every pre-#1505
     * file and on every real movement — the import must not invent one, so there is
     * no default: an absent mark reads as «nadie lo ha dicho», which is what it is.
     */
    costBasisGrade: costBasisGradeSchema.optional(),
  }),
);

// ── Warnings, FIRE configuration and the price cache ────────────────────────

const warningOverrideSchema = reproduces<WarningOverride>()(
  z.object({
    code: nonEmptyString,
    entityId: nonEmptyString,
  }),
);

const fireScopeConfigSchema = reproduces<FireScopeConfig>()(
  z.object({
    monthlySpendingMinor: z.number().int(),
    safeWithdrawalRate: z.number(),
    expectedRealReturn: z.number().optional(),
    /** Legacy typed age (#1415): still parsed so pre-#1415 exports import intact. */
    currentAge: z.number().optional(),
    targetRetirementAge: z.number().optional(),
    excludedAssetIds: z.array(nonEmptyString).optional(),
    monthlySavingsCapacityMinor: z.number().int().optional(),
    /** #1416 seed marker: survives a transfer so the "check it" note is not lost. */
    monthlySavingsCapacitySeededFromPlan: z.boolean().optional(),
    leanMultiplier: z.number().optional(),
    fatMultiplier: z.number().optional(),
    baristaMonthlyIncomeMinor: z.number().int().optional(),
    /** Per-rung overrides, keyed by the ladder itself — an unknown key is a typo,
     *  not a rung, and silently keeping it would feed the weighted rate garbage. */
    tierRealReturns: z.partialRecord(liquidityTierSchema, z.number()).optional(),
    /** The user's own declarations about their plan (#1428, #1460, ADR 0078/0081).
     *  Carried because they are DECLARED data with no other source: derived on
     *  restore they would come back as the neutral default and quietly move the
     *  FIRE figures of anyone who had said otherwise. */
    immobilizedCountsAsFireCapital: z.boolean().optional(),
    retirementPlan: fireRetirementPlanSchema.optional(),
    ordinaryRetirementAge: z.number().optional(),
    capitalLastsUntilAge: z.number().optional(),
    /** ¿El gasto declarado incluye la cuota? (#1520.) Tres estados: ausente = sin
     *  declarar, y traerlo de vuelta como `false` sería inventar la respuesta. */
    monthlySpendingIncludesDebtService: z.boolean().optional(),
  }),
);

const domainWarningSchema = reproduces<DomainWarning>()(
  z.object({
    code: nonEmptyString,
    severity: warningSeveritySchema,
    entityType: warningEntityTypeSchema,
    entityId: nonEmptyString,
    message: z.string(),
  }),
);

const priceSchema = reproduces<AssetPrice>()(
  z.object({
    assetId: nonEmptyString,
    // A plain string, NOT `currencySchema`: `AssetPrice.currency` is `string` in
    // the domain, and typing it tighter here than the type it reproduces would be
    // the anchor's own promise pointing the wrong way.
    currency: nonEmptyString,
    price: nonEmptyString,
    source: priceSourceSchema,
    priceDate: nonEmptyString.optional(),
    fetchedAt: nonEmptyString,
    freshnessState: priceFreshnessStateSchema,
    staleReason: nonEmptyString.optional(),
  }),
);

// ── Snapshots (ADR 0008) ────────────────────────────────────────────────────

// One frozen per-position child row beneath a connected-source holding (ADR
// 0035, PRD #459 S3): values + labels only, never secrets. A coin's metal and a
// position's thumbnail are nullable; a token freezes both null.
const snapshotPositionSchema = reproduces<SnapshotPositionRow>()(
  z.object({
    positionKey: nonEmptyString,
    label: nonEmptyString,
    valueMinor: z.number().int(),
    metal: nonEmptyString.nullable(),
    imageUrl: nonEmptyString.nullable(),
  }),
);

const snapshotHoldingSchema = reproduces<SnapshotHoldingRow>()(
  z.object({
    // Frozen housing-membership signal for ASSET rows (#181). Defaults false for
    // exports written before the field existed — the same additive basis the v17
    // migration backfill uses, so an old export never claims an asset was a housing
    // asset it cannot prove. Always false for liability rows.
    countsAsHousing: z.boolean().default(false),
    holdingId: nonEmptyString,
    kind: snapshotHoldingKindSchema,
    label: nonEmptyString,
    liquidityTier: liquidityTierSchema.nullable(),
    // Frozen housing-securing signal (#180). Defaults false for exports written
    // before the field existed — the same additive basis the migration backfill
    // uses, so an old export never claims a debt secures housing it cannot prove.
    securesHousing: z.boolean().default(false),
    valueMinor: z.number().int(),
    units: nonEmptyString.optional(),
    unitPrice: nonEmptyString.optional(),
    // Per-position breakdown of a connected-source holding (ADR 0035, PRD #459 S3).
    // OPTIONAL with NO default: absent must stay `undefined`, never `[]` — the
    // reconciliation skips a holding with no positions, but an empty array would
    // fail the sub-sum (Σ == holding) against the holding's nonzero value. A legacy
    // export omits it entirely and imports unchanged.
    positions: z.array(snapshotPositionSchema).optional(),
  }),
);

const snapshotSchema = reproduces<
  NetWorthSnapshot & { holdings: SnapshotHoldingRow[] }
>()(
  z.object({
    id: nonEmptyString,
    scopeId: nonEmptyString,
    scopeLabel: nonEmptyString,
    capturedAt: nonEmptyString,
    dateKey: nonEmptyString,
    monthKey: nonEmptyString,
    isMonthlyClose: z.boolean(),
    totalNetWorth: moneyMinorSchema,
    liquidNetWorth: moneyMinorSchema,
    housingEquity: moneyMinorSchema,
    grossAssets: moneyMinorSchema,
    debts: moneyMinorSchema,
    warnings: z.array(domainWarningSchema).default([]),
    holdings: z.array(snapshotHoldingSchema).default([]),
  }),
);

/**
 * A frozen snapshot plus the valued portfolio behind its figures (ADR 0008).
 * Holdings may be empty for captures that predate snapshot holdings; when
 * present they must reconcile exactly with the snapshot's headline figures.
 */
export type ExportedSnapshot = z.output<typeof snapshotSchema>;

// ── Connected sources (ADR 0016): the source + its positions, never secrets ──

// A coin position (Numista). `kind` defaults to "coin" so a file written before
// the polymorphism existed (ADR 0021) — which has no `kind` — still imports.
const coinPositionSchema = reproduces<Omit<CoinPosition, "sourceId">>()(
  z.object({
    kind: z.literal("coin").default("coin"),
    id: nonEmptyString,
    externalId: nonEmptyString,
    catalogueId: nonEmptyString,
    issueId: z.number().int().nullable(),
    name: nonEmptyString,
    grade: z.string(),
    quantity: z.number().int(),
    year: z.number().int().nullable(),
    liquidityTier: liquidityTierSchema,
    metal: nonEmptyString.nullable(),
    finenessMillis: z.number().nullable(),
    weightGrams: z.number().nullable(),
    purchaseDate: nonEmptyString.nullable(),
    metalValueMinor: z.number().int().nullable(),
    numismaticValueMinor: z.number().int().nullable(),
    numismaticFetchedAt: nonEmptyString.nullable(),
    purchasePriceMinor: z.number().int().nullable(),
    // The obverse photo URL (#272). Defaults to null so a file written before the
    // gallery existed still imports; re-fetched on the next sync.
    obverseThumbUrl: nonEmptyString.nullable().default(null),
    currency: currencySchema,
  }),
);

// A token balance (Binance, ADR 0021): symbol/balance/wallet + the last live
// unit price; carried by export/import like any other position (credentials
// never are — they live on `connected_sources`, not here).
const tokenPositionSchema = reproduces<Omit<TokenPosition, "sourceId">>()(
  z.object({
    kind: z.literal("token"),
    id: nonEmptyString,
    externalId: nonEmptyString,
    name: nonEmptyString,
    liquidityTier: liquidityTierSchema,
    currency: currencySchema,
    symbol: nonEmptyString,
    balance: nonEmptyString,
    wallet: z.string(),
    unitPrice: nonEmptyString.nullable(),
    // The token's CoinGecko logo URL (#482). Defaults to null so a file written
    // before logos existed still imports; re-fetched on the next sync.
    imageUrl: nonEmptyString.nullable().default(null),
  }),
);

/**
 * One position a connected source mirrors, carried in the file (ADR 0016): the
 * full sub-detail of the coin/line, with its id preserved for a faithful
 * restore. The `sourceId` is implied by nesting under the source, so it is
 * omitted here.
 *
 * First match wins: a token position fails the coin schema (no catalogue/quantity)
 * and parses as a token; a coin position (with or without an explicit `kind`)
 * parses as a coin.
 */
const positionSchema = coversUnion<DistributiveOmit<SourcePosition, "sourceId">>()(
  z.union([coinPositionSchema, tokenPositionSchema]),
);

export type ExportedPosition = z.output<typeof positionSchema>;

const connectedSourceSchema = z.object({
  id: nonEmptyString,
  adapter: sourceAdapterSchema,
  label: nonEmptyString,
  /** The materialized rolled-up holding this source projects into. */
  assetId: nonEmptyString,
  /** ISO timestamp of the last sync; absent when the source never synced. */
  lastSyncAt: nonEmptyString.optional(),
  positions: z.array(positionSchema).default([]),
});

/**
 * One connected source in the file (ADR 0016): the adapter, its label, the
 * asset it projects into, when it last synced, and its positions. Credentials
 * and cached tokens are LOCAL-ONLY and NEVER exported — a restored source must
 * have its API key re-entered before it can sync again.
 */
export type ExportedConnectedSource = z.output<typeof connectedSourceSchema>;

// ── Agent-view public ids ───────────────────────────────────────────────────

const publicIdEntityTypeSchema = z.enum([
  "scope",
  "member",
  "member_group",
  "holding",
  "managed_portfolio",
]);

export type ExportedPublicIdEntityType = z.output<typeof publicIdEntityTypeSchema>;

const publicIdSchema = z.object({
  entityType: publicIdEntityTypeSchema,
  entityId: nonEmptyString,
  publicId: nonEmptyString,
});

export type ExportedPublicId = z.output<typeof publicIdSchema>;

// ── Payouts, contributions and managed portfolios ───────────────────────────

// Payouts (PRD #652, ADR 0054): attribution records attached to a holding.
// Schedule occurrences are derived on read, never exported — only the declaration.
const payoutSchema = reproduces<Payout>()(
  z.object({
    id: nonEmptyString,
    holdingId: nonEmptyString,
    dateISO: nonEmptyString,
    amountMinor: z.number().int(),
    note: nonEmptyString.optional(),
  }),
);

const payoutScheduleSchema = reproduces<PayoutSchedule>()(
  z.object({
    id: nonEmptyString,
    holdingId: nonEmptyString,
    label: nonEmptyString,
    amountMinor: z.number().int(),
    // Declared cost per occurrence (#1448). Null / absent = not declared, which is
    // not the same statement as a declared 0, so it defaults to null and never 0.
    expensesMinor: z.number().int().nullable().default(null),
    cadence: payoutCadenceSchema,
    startISO: nonEmptyString,
    endISO: nonEmptyString.nullable().default(null),
    exclusions: z.array(nonEmptyString).default([]),
  }),
);

const isoWeekdaySchema: z.ZodType<IsoWeekday, unknown> = z.literal([1, 2, 3, 4, 5, 6, 7]);

const plannedContributionSchema = reproduces<PlannedContribution>()(
  z.object({
    id: nonEmptyString,
    destinationHoldingId: nonEmptyString,
    amount: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("money"), value: z.number().int().positive() }),
      z.object({ mode: z.literal("units"), value: nonEmptyString }),
    ]),
    cadence: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("weekly"), weekday: isoWeekdaySchema }),
      z.object({
        kind: z.literal("monthly"),
        dayOfMonth: z.number().int().min(1).max(31),
      }),
      z.object({ kind: z.literal("quarterly") }),
      z.object({ kind: z.literal("annual") }),
    ]),
    startDate: nonEmptyString,
    endDate: nonEmptyString.optional(),
  }),
);

const contributionPlanSchema = reproduces<ContributionPlan>()(
  z.object({
    scopeId: nonEmptyString,
    contributions: z.array(plannedContributionSchema),
  }),
);

const contributionReconciliationSchema = z.object({
  contributionId: nonEmptyString,
  occurrenceId: nonEmptyString,
  state: contributionOccurrenceStateSchema,
  operationIds: z.array(nonEmptyString),
  storedExecutionMinor: z.number().int().nonnegative().optional(),
});

export type ExportedContributionReconciliation = z.output<
  typeof contributionReconciliationSchema
>;

const contributionAllowanceSchema = reproduces<ContributionAllowance>()(
  z.object({
    id: nonEmptyString,
    scopeId: nonEmptyString,
    label: nonEmptyString,
    annualCapMinor: z.number().int().positive(),
    holdingIds: z.array(nonEmptyString),
  }),
);

const managedPortfolioSchema = reproduces<ManagedPortfolio>()(
  z.object({
    id: nonEmptyString,
    scopeId: nonEmptyString,
    name: nonEmptyString,
    provider: z.string().nullable(),
    holdingIds: z.array(nonEmptyString),
    /**
     * The declared balance travels with the entity (#1550) — it is typed data, and
     * an import that dropped it would silence a careo the owner had set up.
     * Optional so documents exported before S4 still parse as "no witness".
     */
    witness: reproduces<ManagedPortfolioWitness>()(
      z.object({ declaredValue: moneyMinorSchema, declaredDate: nonEmptyString }),
    )
      .nullish()
      .transform((value) => value ?? null),
  }),
);

// ── The document ────────────────────────────────────────────────────────────

/**
 * The versioned export document — the on-disk JSON shape, and the single schema
 * `parseWorkspaceExport` validates against. Absent sections default to empty, so
 * a parsed document is always COMPLETE.
 */
export const workspaceExportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  workspace: workspaceConfigSchema,
  members: z.array(memberSchema).min(1),
  groups: z.array(groupSchema).default([]),
  assets: z.array(assetSchema).default([]),
  liabilities: z.array(liabilitySchema).default([]),
  operations: z.array(operationSchema).default([]),
  warningOverrides: z.array(warningOverrideSchema).default([]),
  fireConfig: z.record(z.string(), fireScopeConfigSchema).default({}),
  snapshots: z.array(snapshotSchema).default([]),
  trash: trashSchema.default({ assets: [], liabilities: [] }),
  priceCache: z.array(priceSchema).default([]),
  /** Connected sources + their positions (ADR 0016); never their secrets. */
  connectedSources: z.array(connectedSourceSchema).default([]),
  /** Public opaque IDs exposed by agent view; exported so restored workspaces keep references stable. */
  publicIds: z.array(publicIdSchema).default([]),
  /**
   * Payouts and payout schedules (PRD #652, ADR 0054), attribution records
   * attached to a holding. Older export files omit the sections and import
   * unchanged. Schedule occurrences are derived on read, never exported.
   */
  payouts: z.array(payoutSchema).default([]),
  payoutSchedules: z.array(payoutScheduleSchema).default([]),
  /** Forecast declarations plus explicit plan→actual attribution metadata (ADR 0041). */
  contributionPlans: z.array(contributionPlanSchema).default([]),
  contributionReconciliations: z.array(contributionReconciliationSchema).default([]),
  /**
   * Annual contribution ceilings (ADR 0080). Only the declared ceiling travels;
   * what has been consumed is derived from the operations that travel with it, so
   * it has nothing to export.
   */
  contributionAllowances: z.array(contributionAllowanceSchema).default([]),
  /**
   * Managed portfolios (ADR 0085) with their memberships flattened onto the
   * entity, like allowances. The member holdings travel as ordinary assets —
   * including the auto-created cash sibling — so only the grouping itself is
   * extra data here.
   */
  managedPortfolios: z.array(managedPortfolioSchema).default([]),
});

/** The versioned export document — the on-disk JSON shape. */
export type WorkspaceExport = z.output<typeof workspaceExportSchema>;

/**
 * The sections a producer may omit; `serializeWorkspaceExport` fills each with an
 * empty value, so a sealed document always carries every section.
 *
 * `serializeWorkspaceExport` names them a second time, one `?? []` each. That
 * repetition is deliberate rather than collapsed into a spread over a defaults
 * object: the compiler already forces it, because `WorkspaceExport` requires
 * every section, so forgetting one here fails to compile. Collapsing it would
 * need an assertion to re-attach the widened `Object.entries` result — trading a
 * repetition the compiler checks for a cast it cannot.
 */
type OmittableSection =
  | "publicIds"
  | "payouts"
  | "payoutSchedules"
  | "contributionPlans"
  | "contributionReconciliations"
  | "contributionAllowances"
  | "managedPortfolios";

/** Every section of the document, without the version stamp. */
export type WorkspaceExportData = Omit<WorkspaceExport, "version" | OmittableSection> &
  Partial<Pick<WorkspaceExport, OmittableSection>>;

/**
 * Per-section counts of an export document, for the import preview: what the
 * user is about to replace their workspace with, before anything is written.
 */
export interface WorkspaceExportSummary {
  members: number;
  groups: number;
  assets: number;
  liabilities: number;
  operations: number;
  snapshots: number;
  trashedAssets: number;
  trashedLiabilities: number;
  warningOverrides: number;
  priceCacheEntries: number;
  fireConfigScopes: number;
  connectedSources: number;
  payouts: number;
  payoutSchedules: number;
  contributionPlans: number;
  contributionReconciliations: number;
  contributionAllowances: number;
  managedPortfolios: number;
}

/** Count every section of an (already validated) export document. */
export function summarizeWorkspaceExport(doc: WorkspaceExport): WorkspaceExportSummary {
  return {
    members: doc.members.length,
    groups: doc.groups.length,
    assets: doc.assets.length,
    liabilities: doc.liabilities.length,
    operations: doc.operations.length,
    snapshots: doc.snapshots.length,
    trashedAssets: doc.trash.assets.length,
    trashedLiabilities: doc.trash.liabilities.length,
    warningOverrides: doc.warningOverrides.length,
    priceCacheEntries: doc.priceCache.length,
    fireConfigScopes: Object.keys(doc.fireConfig).length,
    connectedSources: doc.connectedSources.length,
    payouts: doc.payouts.length,
    payoutSchedules: doc.payoutSchedules.length,
    contributionPlans: doc.contributionPlans.length,
    contributionReconciliations: doc.contributionReconciliations.length,
    contributionAllowances: doc.contributionAllowances.length,
    managedPortfolios: doc.managedPortfolios.length,
  };
}

/** Build the versioned export document from the in-memory section data. */
export function serializeWorkspaceExport(data: WorkspaceExportData): WorkspaceExport {
  return {
    version: EXPORT_VERSION,
    workspace: data.workspace,
    members: data.members,
    groups: data.groups,
    assets: data.assets,
    liabilities: data.liabilities,
    operations: data.operations,
    warningOverrides: data.warningOverrides,
    fireConfig: data.fireConfig,
    snapshots: data.snapshots,
    trash: data.trash,
    priceCache: data.priceCache,
    connectedSources: data.connectedSources,
    publicIds: data.publicIds ?? [],
    payouts: data.payouts ?? [],
    payoutSchedules: data.payoutSchedules ?? [],
    contributionPlans: data.contributionPlans ?? [],
    contributionReconciliations: data.contributionReconciliations ?? [],
    contributionAllowances: data.contributionAllowances ?? [],
    managedPortfolios: data.managedPortfolios ?? [],
  };
}
