import type { Client } from "@libsql/client";

/**
 * Every workspace table, children before parents so FK constraints hold
 * mid-transaction. Shared by the two full-replace paths — `resetWorkspace` and
 * `importWorkspace` — so the delete list can never drift between them, which is
 * exactly why it lives in neither of their modules.
 * Includes audit_log and app_settings: a full replace erases history too.
 */
const WORKSPACE_TABLES = [
  "snapshot_holdings",
  "snapshots",
  "contribution_occurrence_operations",
  "contribution_occurrence_reconciliations",
  "managed_portfolio_holdings",
  "managed_portfolios",
  "contribution_allowance_holdings",
  "contribution_allowances",
  "asset_operations",
  "asset_price_cache",
  // Connected sources project into an asset, with positions beneath the source —
  // children before parents so the FK cascade order holds (ADR 0016).
  "positions",
  "connected_sources",
  "investment_assets",
  "asset_valuations",
  "early_repayments",
  "interest_rate_revisions",
  "liability_balance_rebaselines",
  "amortization_plans",
  "liability_balance_anchors",
  "asset_ownerships",
  "liability_ownerships",
  "warning_overrides",
  "audit_log",
  "payouts",
  "payout_schedules",
  "planned_contributions",
  "liabilities",
  "assets",
  "member_group_members",
  "agent_view_public_ids",
  "member_groups",
  "members",
  "workspace",
  "app_settings",
] as const;

/**
 * Empty every workspace table in {@link WORKSPACE_TABLES} order. Caller-owned
 * transaction: both callers wipe as part of a larger unit of work, so this
 * never opens one of its own.
 *
 * THE STORE-RULE EXCEPTION (see `StoreContext`): a DELETE over a runtime list of
 * table *names*, which Drizzle's typed builder cannot express — so it stays on
 * raw SQL on purpose, and now in exactly one place.
 */
export async function wipeWorkspaceTables(client: Client): Promise<void> {
  for (const table of WORKSPACE_TABLES) {
    await client.execute(`DELETE FROM ${table}`);
  }
}
