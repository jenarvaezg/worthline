import type { LiquidityTier } from "@worthline/domain";
import type {
  AssetType,
  InvestmentPriceProvider,
  LiabilityType,
  OperationKind,
  PriceFreshnessState,
  PriceSource,
  SnapshotHoldingKind,
  WorkspaceMode,
} from "@worthline/domain";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
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

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<AssetType>().notNull(),
  currency: text("currency").notNull(),
  currentValueMinor: integer("current_value_minor").notNull(),
  liquidityTier: text("liquidity_tier").$type<LiquidityTier>().notNull(),
  isPrimaryResidence: integer("is_primary_residence").notNull().default(0),
  deletedAt: text("deleted_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

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

export const assetOperations = sqliteTable("asset_operations", {
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
});

export const liabilities = sqliteTable("liabilities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<LiabilityType>().notNull(),
  currency: text("currency").notNull(),
  currentBalanceMinor: integer("current_balance_minor").notNull(),
  associatedAssetId: text("associated_asset_id").references(() => assets.id, {
    onDelete: "set null",
  }),
  deletedAt: text("deleted_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  createdAt: timestamp("created_at"),
});

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
  ],
);
