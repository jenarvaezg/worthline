import type { LiquidityTier } from "@worthline/contracts";
import type { AssetType, LiabilityType, WorkspaceMode } from "@worthline/domain";
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

export const liabilities = sqliteTable("liabilities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<LiabilityType>().notNull(),
  currency: text("currency").notNull(),
  currentBalanceMinor: integer("current_balance_minor").notNull(),
  associatedAssetId: text("associated_asset_id").references(() => assets.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

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
