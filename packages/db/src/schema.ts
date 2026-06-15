import type { LiquidityTier } from "@worthline/domain";
import type {
  AssetType,
  DebtModel,
  EarlyRepaymentMode,
  Instrument,
  InvestmentPriceProvider,
  LiabilityType,
  OperationKind,
  PriceFreshnessState,
  PriceSource,
  SnapshotHoldingKind,
  SourceAdapter,
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

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

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
});

export const assetOperations = sqliteTable(
  "asset_operations",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OperationKind>().notNull(),
    executedAt: text("executed_at").notNull(),
    units: text("units").notNull(),
    pricePerUnit: text("price_per_unit").notNull(),
    currency: text("currency").notNull(),
    feesMinor: integer("fees_minor").notNull().default(0),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    // Per-investment operation read (#201): WHERE asset_id ORDER BY executed_at, id.
    // The (asset_id, executed_at, id) order matches the filter + sort exactly, so
    // the read is a pure indexed range scan with no temp-b-tree sort.
    index("asset_operations_asset_executed_idx").on(
      table.assetId,
      table.executedAt,
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
 * One line a connected source mirrors — for Numista, a coin you own (PRD #160,
 * ADR 0017). Sits beneath the projected holding as sub-detail, the way an
 * operation sits beneath an investment (ADR 0014). `liquidity_tier` ∈ the ladder
 * vocabulary is enforced in TS (no CHECK); `metal` is grouping metadata for the
 * detail-page lens, null when the source records no metal.
 */
export const positions = sqliteTable("positions", {
  id: text("id").primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => connectedSources.id, { onDelete: "cascade" }),
  // Numista's stable collected-item id — the cross-sync trade key (ADR 0017, #167).
  // Nullable only for legacy rows written before v20; every sync now sets it.
  externalId: text("external_id"),
  catalogueId: text("catalogue_id").notNull(),
  // Numista issue id within the type; null when the source records none. Persisted
  // so the valuation refresh can refetch the per-grade estimate without re-listing
  // the collection (#166).
  issueId: integer("issue_id"),
  name: text("name").notNull(),
  grade: text("grade").notNull(),
  quantity: integer("quantity").notNull(),
  // The coin's mint year from the source's issue (#215); null when the catalogue
  // records none. Distinct from purchase_date (when it was acquired).
  year: integer("year"),
  liquidityTier: text("liquidity_tier").$type<LiquidityTier>().notNull(),
  metal: text("metal"),
  // Indefinite coin detail (ADR 0017): parsed fineness + weight, stamped once at
  // sync and never refetched — the valuation refresh recomputes melt value from
  // these × the daily metal spot (#166).
  finenessMillis: integer("fineness_millis"),
  weightGrams: real("weight_grams"),
  // Optional Numista fields — present only when the user recorded them (#161).
  purchaseDate: text("purchase_date"),
  purchasePriceMinor: integer("purchase_price_minor"),
  // The two candidate values (ADR 0017); null when not resolved (base-metal coin
  // with no spot / no numismatic estimate). Refreshed between syncs (#166).
  metalValueMinor: integer("metal_value_minor"),
  numismaticValueMinor: integer("numismatic_value_minor"),
  // When the numismatic estimate was last fetched (ISO); null until first fetched.
  // Drives the long-TTL refetch gate in the valuation refresh (#166).
  numismaticFetchedAt: text("numismatic_fetched_at"),
  currency: text("currency").notNull(),
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
    capturedAt: text("captured_at").notNull(),
    dateKey: text("date_key").notNull(),
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
