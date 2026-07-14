import type {
  AssetType,
  ContributionOccurrenceState,
  DateKey,
  DebtModel,
  EarlyRepaymentMode,
  ExportedPublicIdEntityType,
  ExposureProfileSource,
  GoalPriority,
  Instant,
  Instrument,
  InvestmentPriceProvider,
  LiabilityType,
  LiquidityTier,
  OperationKind,
  OperationSource,
  PayoutCadence,
  PriceFreshnessState,
  PriceSource,
  RiskTolerance,
  SnapshotHoldingKind,
  SourceAdapter,
  ValuationCadence,
  ValuationMethod,
  WorkspaceMode,
} from "@worthline/domain";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => text(name).notNull().default(sql`CURRENT_TIMESTAMP`);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at"),
});

export const workspace = sqliteTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    mode: text("mode").$type<WorkspaceMode>().notNull(),
    baseCurrency: text("base_currency").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    check("workspace_id_default", sql`${table.id} = 'default'`),
    check("workspace_mode_enum", sql`${table.mode} IN ('individual', 'household')`),
  ],
);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  disabledAt: text("disabled_at"),
  // Member profile (PRD #421, #423). All nullable — a member may have none set.
  birthYear: integer("birth_year"),
  fiscalCountry: text("fiscal_country"),
  riskTolerance: text("risk_tolerance").$type<RiskTolerance>(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const memberGroups = sqliteTable("member_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const memberGroupMembers = sqliteTable(
  "member_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => memberGroups.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.memberId] })],
);

export const agentViewPublicIds = sqliteTable(
  "agent_view_public_ids",
  {
    entityType: text("entity_type").$type<ExportedPublicIdEntityType>().notNull(),
    entityId: text("entity_id").notNull(),
    publicId: text("public_id").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId] }),
    uniqueIndex("agent_view_public_ids_public_id_unique").on(table.publicId),
  ],
);

/** One application of dated facts, regardless of whether it came from UI or ingestion. */
export const factBatches = sqliteTable("fact_batch", {
  id: text("id").primaryKey(),
  trigger: text("trigger").notNull(),
  connectedSourceId: text("connected_source_id"),
  /**
   * Reserved for the sync-run lifecycle in #885. Intentionally nullable and
   * without an FK until a real `sync_runs` table exists; command inputs cannot
   * currently supply a dangling identifier.
   */
  syncRunId: text("sync_run_id"),
  createdAt: timestamp("created_at"),
});

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<AssetType>().notNull(),
    currency: text("currency").notNull(),
    currentValueMinor: integer("current_value_minor").notNull(),
    liquidityTier: text("liquidity_tier").$type<LiquidityTier>().notNull(),
    isPrimaryResidence: integer("is_primary_residence").notNull().default(0),
    /**
     * How the holding's value evolves (ADR 0014, #148): stored | derived |
     * appreciating | amortized | anchored. Nullable forward-prep — backfilled from
     * `type` by the v13 migration; in S2 the dispatcher still derives the method at
     * the valuation boundary. No CHECK — the enum is enforced in TS, like
     * `liquidity_tier`.
     */
    valuationMethod: text("valuation_method").$type<ValuationMethod>(),
    /**
     * How a MODELED holding's value moves between its own event dates (ADR 0031,
     * #393): step | interpolated. Nullable — `null` reads as the default `step`
     * (the v33 migration adds the column without a value backfill). Only meaningful
     * for the modeled methods (`appreciating` here); market-priced holdings ignore
     * it. No CHECK — the enum is enforced in TS, like `valuation_method`.
     */
    valuationCadence: text("valuation_cadence").$type<ValuationCadence>(),
    /**
     * What the holding is (ADR 0014, #149): one of the instrument vocabulary
     * (current_account, fund, property, …). Nullable — backfilled from `type`
     * (and the investment's price provider) by the v14 migration. No CHECK — the
     * enum is enforced in TS, like `liquidity_tier` / `valuation_method`. Housing
     * equity is re-sourced from `instrument = 'property'`.
     */
    instrument: text("instrument").$type<Instrument>(),
    /**
     * Decimal-string annual appreciation rate (e.g. "0.03") used to drift a
     * real-estate asset's value between/beyond its valuation anchors. Null means
     * no drift. Only meaningful for real_estate assets — the guard lives in the
     * domain/caller, not as a SQL constraint (PRD #108, slice 4 / pattern R9).
     */
    annualAppreciationRate: text("annual_appreciation_rate"),
    /**
     * The connected source this asset materializes a rung of (ADR 0016/0021, #248);
     * null for a hand-maintained holding. A source now materializes ONE asset per
     * occupied liquidity rung (Binance market + term-locked), so the back-link lives
     * here on the asset rather than only on `connected_sources.asset_id` (which
     * names a single primary asset). DELIBERATELY a plain column with NO `.references`:
     * `connected_sources.asset_id → assets ON DELETE cascade` already points the other
     * way, and a reciprocal FK would form a cascade cycle SQLite rejects. The link is
     * enforced/maintained by the store (connect, reroll, disconnect), not by a FK.
     */
    connectedSourceId: text("connected_source_id"),
    deletedAt: text("deleted_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    // Trash read (#201): WHERE deleted_at IS NOT NULL ORDER BY name. A PARTIAL
    // index over only the trashed rows — keyed by name so the read is an indexed
    // lookup with no temp-b-tree sort, and the index stays tiny because live
    // holdings (the overwhelming majority) are excluded.
    index("assets_deleted_at_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

/**
 * Manual valuation anchors for a real-estate asset (PRD #108, slice 4). Each row
 * is either a market appraisal or an improvement, distinguished by
 * `adjusts_prior_curve`:
 *  - true  (market appraisal): `value_minor` is the TOTAL value on that date.
 *  - false (improvement/reform): `value_minor` is the INCREMENT added from that
 *    date onward.
 *
 * The `asset_id → real_estate` invariant is enforced by the domain/caller (R9),
 * not by a SQL constraint. The unique index keeps one anchor per asset per date.
 */
export const assetValuations = sqliteTable(
  "asset_valuations",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    valueMinor: integer("value_minor").notNull(),
    valuationDate: text("valuation_date").notNull(),
    adjustsPriorCurve: integer("adjusts_prior_curve").notNull(),
    source: text("source").$type<"manual" | "agent">().notNull().default("manual"),
    batchId: text("batch_id").references(() => factBatches.id),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("asset_valuations_asset_date_unique").on(
      table.assetId,
      table.valuationDate,
    ),
  ],
);

export const assetOwnerships = sqliteTable(
  "asset_ownerships",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    shareBps: integer("share_bps").notNull(),
  },
  (table) => [primaryKey({ columns: [table.assetId, table.memberId] })],
);

export const investmentAssets = sqliteTable("investment_assets", {
  assetId: text("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  unitSymbol: text("unit_symbol"),
  isin: text("isin"),
  priceProvider: text("price_provider").$type<InvestmentPriceProvider>(),
  providerSymbol: text("provider_symbol"),
  manualPricePerUnit: text("manual_price_per_unit"),
  manualPricedAt: text("manual_priced_at"),
  /** Per-holding benchmark honesty: compare vs price index when distributing (#625). */
  benchmarkDistributing: integer("benchmark_distributing").notNull().default(0),
});

export const exposureProfiles = sqliteTable("exposure_profiles", {
  key: text("key").primaryKey(),
  source: text("source").$type<ExposureProfileSource>().notNull().default("user"),
  declaredAt: text("declared_at"),
  trackedIndex: text("tracked_index"),
  ter: text("ter"),
  hedged: integer("hedged").notNull().default(0),
  breakdownsJson: text("breakdowns_json").notNull().default("{}"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// Payouts (PRD #652 / ADR 0054): attribution records, never figures. A payout
// attaches to one asset holding and touches no snapshot or ripple; FK cascade
// removes them when the holding is hard-deleted.
export const payouts = sqliteTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    holdingId: text("holding_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("payouts_holding_date_idx").on(table.holdingId, table.date, table.id),
  ],
);

// A declared fixed recurrence. Only the declaration is stored; occurrences are
// derived on read (never materialized). Exclusions are a JSON array of ISO dates.
export const payoutSchedules = sqliteTable(
  "payout_schedules",
  {
    id: text("id").primaryKey(),
    holdingId: text("holding_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    cadence: text("cadence").$type<PayoutCadence>().notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    exclusionsJson: text("exclusions_json").notNull().default("[]"),
    createdAt: timestamp("created_at"),
  },
  (table) => [index("payout_schedules_holding_idx").on(table.holdingId, table.id)],
);

export const assetOperations = sqliteTable(
  "asset_operations",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OperationKind>().notNull(),
    executedAt: text("executed_at").$type<DateKey>().notNull(),
    occurredAt: text("occurred_at").$type<Instant>(),
    units: text("units").notNull(),
    pricePerUnit: text("price_per_unit").notNull(),
    currency: text("currency").notNull(),
    feesMinor: integer("fees_minor").notNull().default(0),
    source: text("source").$type<OperationSource>().notNull().default("manual"),
    batchId: text("batch_id").references(() => factBatches.id),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    // Per-investment read: WHERE asset_id ORDER BY executed_at, occurred_at, id.
    // The index order matches the filter + canonical ledger sort exactly, so
    // the read is a pure indexed range scan with no temp-b-tree sort.
    index("asset_operations_asset_executed_idx").on(
      table.assetId,
      table.executedAt,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const liabilities = sqliteTable(
  "liabilities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<LiabilityType>().notNull(),
    currency: text("currency").notNull(),
    currentBalanceMinor: integer("current_balance_minor").notNull(),
    associatedAssetId: text("associated_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /**
     * How the liability is modelled for historical reconstruction (PRD #109,
     * slice 7): "amortizable" | "revolving" | "informal". Null means no model is
     * declared — the current balance is used as-is, with no derived history.
     */
    debtModel: text("debt_model").$type<DebtModel>(),
    /** Valuation method (ADR 0014, #148); backfilled from `debt_model` by the v13 migration. */
    valuationMethod: text("valuation_method").$type<ValuationMethod>(),
    /**
     * How a MODELED balance moves between events (ADR 0031, #393): step |
     * interpolated. Nullable — `null` reads as the default `step` (the v33
     * migration adds the column without a value backfill). Only meaningful for the
     * `amortizable`/`revolving` models; `informal` is always a step. No CHECK —
     * the enum is enforced in TS, like `valuation_method`.
     */
    valuationCadence: text("valuation_cadence").$type<ValuationCadence>(),
    /** What the liability is (ADR 0014, #149): mortgage | loan | credit_card. Backfilled by v14. */
    instrument: text("instrument").$type<Instrument>(),
    deletedAt: text("deleted_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    // Trash read (#201): WHERE deleted_at IS NOT NULL ORDER BY name. The asset-side
    // partial index's mirror — only trashed liabilities are indexed, keyed by name.
    index("liabilities_deleted_at_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

/**
 * One French-amortization plan for an amortizable liability (PRD #109, slice 7).
 * Carries TWO dates (ADR 0019, #188): a disbursement date (firma / devengo — the
 * debt appears at its initial capital) and a first-payment date (the first cuota;
 * the balance amortizes from here on its day-of-month, term counted from here).
 * The `liability_id → debt_model = "amortizable"` invariant is a domain/caller
 * guard, not a SQL constraint (pattern R9). The unique index keeps the plan 1:1
 * with its liability.
 */
export const amortizationPlans = sqliteTable(
  "amortization_plans",
  {
    id: text("id").primaryKey(),
    liabilityId: text("liability_id")
      .notNull()
      .references(() => liabilities.id, { onDelete: "cascade" }),
    initialCapitalMinor: integer("initial_capital_minor").notNull(),
    annualInterestRate: text("annual_interest_rate").notNull(),
    termMonths: integer("term_months").notNull(),
    /** Disbursement date (firma / devengo), YYYY-MM-DD — when the debt appears at
     * its initial capital and interest begins to accrue (ADR 0019, #188). */
    disbursementDate: text("disbursement_date").notNull(),
    /** First-payment date, YYYY-MM-DD — the first cuota; the balance amortizes
     * from here on this date's day-of-month, term counted from here (ADR 0019). */
    firstPaymentDate: text("first_payment_date").notNull(),
    /**
     * Optional descriptive metadata (ADR 0056, #677): the debt's true original
     * signing date, for a plan created by current-state entry whose
     * `disbursementDate` is the re-baseline date, not the real firma. Nullable,
     * never read by the balance curve — display-only identity, like `firstCuota`.
     */
    originalSigningDate: text("original_signing_date"),
    createdAt: timestamp("created_at"),
  },
  (table) => [uniqueIndex("amortization_plans_liability_unique").on(table.liabilityId)],
);

/**
 * A scheduled interest-rate change on an amortization plan (PRD #109, slice 7).
 * The unique index keeps one revision per plan per date.
 */
export const interestRateRevisions = sqliteTable(
  "interest_rate_revisions",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => amortizationPlans.id, { onDelete: "cascade" }),
    revisionDate: text("revision_date").notNull(),
    newAnnualInterestRate: text("new_annual_interest_rate").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("interest_rate_revisions_plan_date_unique").on(
      table.planId,
      table.revisionDate,
    ),
  ],
);

/**
 * A lump-sum early repayment (amortización anticipada) against an amortization
 * plan (PRD #146, slice S4). `amount_minor` is the principal repaid; `mode`
 * chooses whether the remaining schedule keeps the term (reduce-payment) or the
 * cuota (reduce-term). The unique index keeps one repayment per plan per date.
 */
export const earlyRepayments = sqliteTable(
  "early_repayments",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => amortizationPlans.id, { onDelete: "cascade" }),
    repaymentDate: text("repayment_date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    mode: text("mode").$type<EarlyRepaymentMode>().notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("early_repayments_plan_date_unique").on(
      table.planId,
      table.repaymentDate,
    ),
  ],
);

/**
 * A current-state balance re-baseline for an amortizable liability (ADR 0056,
 * #676). The fact lives on the liability, not as a new valuation method: at and
 * after `baseline_date`, the amortized curve derives an effective French plan
 * from the declared outstanding balance, next cuota date, end date, and rate.
 */
export const liabilityBalanceRebaselines = sqliteTable(
  "liability_balance_rebaselines",
  {
    id: text("id").primaryKey(),
    liabilityId: text("liability_id")
      .notNull()
      .references(() => liabilities.id, { onDelete: "cascade" }),
    baselineDate: text("baseline_date").notNull(),
    outstandingBalanceMinor: integer("outstanding_balance_minor").notNull(),
    endDate: text("end_date").notNull(),
    nextPaymentDate: text("next_payment_date").notNull(),
    annualInterestRate: text("annual_interest_rate").notNull(),
    monthlyPaymentMinor: integer("monthly_payment_minor").notNull(),
    inputMode: text("input_mode").$type<"annual-rate" | "monthly-payment">().notNull(),
    startsAtBaseline: integer("starts_at_baseline", { mode: "boolean" })
      .default(false)
      .notNull(),
    source: text("source").$type<"manual" | "agent">().notNull().default("manual"),
    batchId: text("batch_id").references(() => factBatches.id),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("liability_balance_rebaselines_liability_date_unique").on(
      table.liabilityId,
      table.baselineDate,
    ),
  ],
);

/**
 * A declared balance for a revolving or informal liability on a given date (PRD
 * #109, slice 8). `balance_minor` is the TOTAL owed on that date — if the debt
 * accrues interest the user declares it already included; there is intentionally
 * no "includes interest" flag (firm PRD #109 decision).
 *
 * The `liability_id → debt_model ∈ {revolving, informal}` invariant is a
 * domain/caller guard, not a SQL constraint (pattern R9). The unique index keeps
 * one anchor per liability per date.
 */
export const liabilityBalanceAnchors = sqliteTable(
  "liability_balance_anchors",
  {
    id: text("id").primaryKey(),
    liabilityId: text("liability_id")
      .notNull()
      .references(() => liabilities.id, { onDelete: "cascade" }),
    balanceMinor: integer("balance_minor").notNull(),
    anchorDate: text("anchor_date").notNull(),
    batchId: text("batch_id").references(() => factBatches.id),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("liability_balance_anchors_liability_date_unique").on(
      table.liabilityId,
      table.anchorDate,
    ),
  ],
);

/**
 * A connected source: an external account worthline mirrors read-only (PRD #160,
 * ADR 0016/0017). It projects its positions into ONE rolled-up holding (the
 * `asset_id` row), whose value is derived from the positions — never hand-set.
 * `adapter` ∈ {numista} is enforced in TS, like the other text enums (no CHECK).
 * `credentials_json` (API key + OAuth client) and `token_json` (cached access
 * token + expiry) are LOCAL ONLY and never exported (ADR 0016).
 */
export const connectedSources = sqliteTable("connected_sources", {
  id: text("id").primaryKey(),
  adapter: text("adapter").$type<SourceAdapter>().notNull(),
  label: text("label").notNull(),
  // The materialized rolled-up holding this source projects into (ADR 0016).
  assetId: text("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  // Local-only secrets — NEVER exported (ADR 0016). JSON blob of API key + OAuth client.
  credentialsJson: text("credentials_json").notNull(),
  // Cached OAuth token JSON (access_token + expiry); null until first mint.
  tokenJson: text("token_json"),
  lastSyncAt: text("last_sync_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

/**
 * One line a connected source mirrors — a Numista coin or a Binance token balance
 * (PRD #160/#245, ADR 0017/0021). Sits beneath the projected holding as
 * sub-detail, the way an operation sits beneath an investment (ADR 0014).
 *
 * `kind` ('coin' | 'token') is the polymorphism discriminant (ADR 0021). The coin
 * columns (catalogue/grade/quantity/metal/…) and the token columns
 * (symbol/balance/wallet/unit_price) are ALL nullable: a row of one kind leaves
 * the other kind's columns null, with per-kind required-ness enforced in TS
 * (CoinPosition / TokenPosition) rather than by SQL CHECKs — like `liquidity_tier`
 * and `valuation_method`. `liquidity_tier` ∈ the ladder vocabulary; `metal`/
 * `symbol` are the detail-page grouping lenses.
 */
export const positions = sqliteTable("positions", {
  id: text("id").primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => connectedSources.id, { onDelete: "cascade" }),
  // Polymorphism discriminant (ADR 0021): 'coin' (Numista) | 'token' (Binance).
  // Defaults to 'coin' so rows written before v25 (all coins) classify correctly.
  kind: text("kind").$type<"coin" | "token">().notNull().default("coin"),
  // The source's stable per-line id — the cross-sync identity key (a Numista
  // collected-item id, ADR 0017 #167; or a Binance `SYMBOL:wallet` key). Nullable
  // only for legacy rows written before v20; every sync now sets it.
  externalId: text("external_id"),
  name: text("name").notNull(),
  liquidityTier: text("liquidity_tier").$type<LiquidityTier>().notNull(),
  currency: text("currency").notNull(),
  // ── Coin fields (Numista) — null on a token row. ─────────────────────────────
  catalogueId: text("catalogue_id"),
  // Numista issue id within the type; null when the source records none. Persisted
  // so the valuation refresh can refetch the per-grade estimate without re-listing
  // the collection (#166).
  issueId: integer("issue_id"),
  grade: text("grade"),
  quantity: integer("quantity"),
  // The coin's mint year from the source's issue (#215); null when the catalogue
  // records none. Distinct from purchase_date (when it was acquired).
  year: integer("year"),
  metal: text("metal"),
  // Indefinite coin detail (ADR 0017): parsed fineness + weight, stamped once at
  // sync and never refetched — the valuation refresh recomputes melt value from
  // these × the daily metal spot (#166).
  finenessMillis: integer("fineness_millis"),
  weightGrams: real("weight_grams"),
  // Optional Numista fields — present only when the user recorded them (#161).
  purchaseDate: text("purchase_date"),
  purchasePriceMinor: integer("purchase_price_minor"),
  // The obverse photo's thumbnail URL from Numista, stamped once at sync (#272);
  // null when the catalogue has no photo → the gallery shows a metal glyph.
  obverseThumbUrl: text("obverse_thumb_url"),
  // The two candidate values (ADR 0017); null when not resolved (base-metal coin
  // with no spot / no numismatic estimate). Refreshed between syncs (#166).
  metalValueMinor: integer("metal_value_minor"),
  numismaticValueMinor: integer("numismatic_value_minor"),
  // When the numismatic estimate was last fetched (ISO); null until first fetched.
  // Drives the long-TTL refetch gate in the valuation refresh (#166).
  numismaticFetchedAt: text("numismatic_fetched_at"),
  // ── Token fields (Binance, ADR 0021) — null on a coin row. ───────────────────
  // The Binance asset symbol (e.g. "BTC") — the detail-page grouping lens and the
  // symbol→CoinGecko-id resolver key.
  symbol: text("symbol"),
  // The token BALANCE (a quantity, decimal string) — not a frozen value; the
  // holding's value is derived live as balance × unit_price (ADR 0021).
  balance: text("balance"),
  // Which Binance wallet the balance came from (e.g. "spot"); a token held across
  // wallets is summed into one position (#247).
  wallet: text("wallet"),
  // The last-fetched live EUR unit price (decimal string); null when the symbol
  // cannot be mapped/priced → value 0 + "value at 0" warning. Refreshed by sync/
  // the stale-price pass (#249).
  unitPrice: text("unit_price"),
  // The token's logo URL, resolved from CoinGecko at sync (#482, the live mirror of
  // a coin's obverse_thumb_url); null when the symbol has no image → glyph fallback.
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    // Per-entity audit read (#201): WHERE entity_id ORDER BY created_at. The
    // (entity_id, created_at) order matches the filter + sort, so a holding's
    // history is a pure indexed range scan with no temp-b-tree sort.
    index("audit_log_entity_created_idx").on(table.entityId, table.createdAt),
  ],
);

export const warningOverrides = sqliteTable(
  "warning_overrides",
  {
    code: text("code").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [primaryKey({ columns: [table.code, table.entityId] })],
);

export const liabilityOwnerships = sqliteTable(
  "liability_ownerships",
  {
    liabilityId: text("liability_id")
      .notNull()
      .references(() => liabilities.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    shareBps: integer("share_bps").notNull(),
  },
  (table) => [primaryKey({ columns: [table.liabilityId, table.memberId] })],
);

export const assetPriceCache = sqliteTable("asset_price_cache", {
  assetId: text("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),
  price: text("price").notNull(),
  source: text("source").$type<PriceSource>().notNull().default("manual"),
  priceDate: text("price_date"),
  fetchedAt: text("fetched_at").notNull(),
  freshnessState: text("freshness_state")
    .$type<PriceFreshnessState>()
    .notNull()
    .default("manual"),
  staleReason: text("stale_reason"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    scopeLabel: text("scope_label").notNull(),
    capturedAt: text("captured_at").$type<Instant>().notNull(),
    dateKey: text("date_key").$type<DateKey>().notNull(),
    monthKey: text("month_key").notNull(),
    isMonthlyClose: integer("is_monthly_close").notNull().default(0),
    currency: text("currency").notNull(),
    totalNetWorthMinor: integer("total_net_worth_minor").notNull(),
    liquidNetWorthMinor: integer("liquid_net_worth_minor").notNull(),
    housingEquityMinor: integer("housing_equity_minor").notNull(),
    grossAssetsMinor: integer("gross_assets_minor").notNull(),
    debtsMinor: integer("debts_minor").notNull(),
    warningsJson: text("warnings_json").notNull().default("[]"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("snapshots_scope_date_unique").on(table.scopeId, table.dateKey),
  ],
);

/**
 * One frozen holding row behind a snapshot's figures (ADR 0008).
 *
 * Label and liquidity tier are denormalized at capture time on purpose: a
 * snapshot is frozen, so later renames, re-tierings, or deletions of a holding
 * must never alter what a past snapshot captured. `holding_id` is informational
 * — there is intentionally NO foreign key into assets/liabilities. The only FK
 * points at the owning snapshot row.
 */
export const snapshotHoldings = sqliteTable(
  "snapshot_holdings",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    holdingId: text("holding_id").notNull(),
    kind: text("kind").$type<SnapshotHoldingKind>().notNull(),
    label: text("label").notNull(),
    liquidityTier: text("liquidity_tier").$type<LiquidityTier>(),
    /**
     * Whether this holding secures a housing asset, frozen at capture time from
     * the all-assets classification (#180). Stored as 0/1; the only meaningful
     * non-zero rows are liabilities associated to a housing asset. Denormalized
     * on purpose, like the tier — no live foreign key into holdings (ADR 0008).
     */
    securesHousing: integer("secures_housing").notNull().default(0),
    /**
     * Whether this ASSET holding counted as a housing asset at capture time,
     * frozen from the live `isHousingAsset` classification (#181). Always 0 for
     * liabilities. Combined with `secures_housing` on the liability side this
     * makes the entire housing-equity axis row-derivable from the frozen flags —
     * no live lookup needed. Stored as 0/1; default 0 for existing rows (the
     * v17 migration backfills 1 for current housing assets, same basis as v16).
     */
    countsAsHousing: integer("counts_as_housing").notNull().default(0),
    valueMinor: integer("value_minor").notNull(),
    units: text("units"),
    unitPrice: text("unit_price"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("snapshot_holdings_snapshot_kind_holding_unique").on(
      table.snapshotId,
      table.kind,
      table.holdingId,
    ),
    // Targeted single-holding reads (#207): the housing valuation ripples find the
    // earliest frozen row of one asset by (holding_id, kind). The unique index
    // above leads with snapshot_id, so it can't serve a holding-first lookup —
    // this index does, turning a full snapshot_holdings scan into a lookup.
    index("snapshot_holdings_holding_kind_idx").on(table.holdingId, table.kind),
  ],
);

/**
 * Per-position breakdown of a connected-source holding, frozen into a snapshot as
 * child rows of its holding row (ADR 0035, PRD #459). One row per coin/token per
 * snapshot. The parent is identified by (snapshot_id, parent_holding_id) — the
 * connected holding is always an asset, so no kind is needed. `position_key` is the
 * source's STABLE id (a coin's Numista `externalId`, ADR 0017), NOT worthline's
 * internal position id (reassigned each sync) — so there is deliberately NO foreign
 * key to `positions`; a re-sync must never cascade-delete frozen history. Values and
 * labels only — never credentials, tokens or raw provider payloads. The rows sum
 * EXACTLY to the parent holding's value (the ADR 0008 reconciliation sub-sum).
 */
export const snapshotPositionHoldings = sqliteTable(
  "snapshot_position_holdings",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    /** The parent snapshot-holding's holding id (the materialized asset). */
    parentHoldingId: text("parent_holding_id").notNull(),
    /** The source's stable per-line id — a coin's Numista externalId (ADR 0017). */
    positionKey: text("position_key").notNull(),
    /** The position's display name, frozen at capture. */
    label: text("label").notNull(),
    /** The scope-weighted value in minor units; Σ per holding == the holding value. */
    valueMinor: integer("value_minor").notNull(),
    /** Grouping-lens metadata (a coin's metal); null when the source records none. */
    metal: text("metal"),
    /** Obverse thumbnail URL for the gallery image; null → metal-glyph fallback. */
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("snapshot_position_holdings_snapshot_holding_key_unique").on(
      table.snapshotId,
      table.parentHoldingId,
      table.positionKey,
    ),
  ],
);

/** A scope's planned contributions (ADR 0041, PRD #553 S1). Forecast metadata only. */
export const plannedContributions = sqliteTable(
  "planned_contributions",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    destinationHoldingId: text("destination_holding_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    amountJson: text("amount_json").notNull(),
    cadenceJson: text("cadence_json").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    createdAt: timestamp("created_at"),
  },
  (table) => [index("planned_contributions_scope_idx").on(table.scopeId, table.id)],
);

/** Explicit plan→actual closure metadata; occurrences themselves remain derived. */
export const contributionOccurrenceReconciliations = sqliteTable(
  "contribution_occurrence_reconciliations",
  {
    occurrenceId: text("occurrence_id").primaryKey(),
    contributionId: text("contribution_id")
      .notNull()
      .references(() => plannedContributions.id, { onDelete: "cascade" }),
    state: text("state").$type<ContributionOccurrenceState>().notNull(),
    storedExecutionMinor: integer("stored_execution_minor"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("contribution_reconciliations_contribution_idx").on(
      table.contributionId,
      table.occurrenceId,
    ),
  ],
);

/** One occurrence may have many executions; one execution may close at most one occurrence. */
export const contributionOccurrenceOperations = sqliteTable(
  "contribution_occurrence_operations",
  {
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => contributionOccurrenceReconciliations.occurrenceId, {
        onDelete: "cascade",
      }),
    operationId: text("operation_id")
      .notNull()
      .references(() => assetOperations.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.occurrenceId, table.operationId] }),
    uniqueIndex("contribution_occurrence_operation_unique").on(table.operationId),
  ],
);

/** Intermediate financial goals (PRD #421, #424). */
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  scopeId: text("scope_id").notNull(),
  name: text("name").notNull(),
  targetAmountMinor: integer("target_amount_minor").notNull(),
  deadline: text("deadline").notNull(),
  priority: text("priority").$type<GoalPriority>().notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

/** Holdings assigned to a goal (PRD #421, #424); a goal reserves their value. */
export const goalHoldings = sqliteTable(
  "goal_holdings",
  {
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.goalId, table.assetId] })],
);

export type AssistantProposalKind =
  | "statement_import"
  | "balance_history_import"
  | "property_valuation_anchor"
  | "mixed_document_import";
export type AssistantProposalStatus = "draft" | "applied" | "discarded";
export type AssistantDocumentProvenance = "agent" | "user";

/** Durable assistant work awaiting an explicit user resolution (#767). */
export const assistantProposals = sqliteTable("assistant_proposals", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<AssistantProposalKind>().notNull(),
  status: text("status").$type<AssistantProposalStatus>().notNull().default("draft"),
  resolvedAt: text("resolved_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

/** Document identity and parse metadata only. Raw document contents are never stored. */
export const assistantProposalDocuments = sqliteTable(
  "assistant_proposal_documents",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => assistantProposals.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    sha256: text("sha256").notNull(),
    provenance: text("provenance").$type<AssistantDocumentProvenance>().notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("assistant_proposal_documents_sequence_unique").on(
      table.proposalId,
      table.sequence,
    ),
  ],
);

/** Typed, structured proposal facts derived from one document. */
export const assistantProposalFacts = sqliteTable(
  "assistant_proposal_facts",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => assistantProposalDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("assistant_proposal_facts_ordinal_unique").on(
      table.documentId,
      table.ordinal,
    ),
  ],
);
