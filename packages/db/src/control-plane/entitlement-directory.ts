import type { WorkspaceBillingState } from "@db/billing";
import { trialEndsAtFrom, type WorkspaceEntitlement } from "@db/entitlements";
import type { Client } from "@libsql/client";

/**
 * Tables owned by the entitlement port: the workspace's stored plan, the
 * per-identity trial marker (#1128) and the billing webhook idempotency
 * ledger (#1135).
 */
export const ENTITLEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_entitlements (
  workspace_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  trial_ends_at TEXT,
  premium_until TEXT,
  billing_provider TEXT,
  billing_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT,
  onboarded_at TEXT,
  first_holding_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
-- Billing webhook idempotency (PRD #1160 S5, #1135): one row per delivered
-- provider event id — an insert that loses means "already processed". Keyed per
-- provider so two MoRs can never collide on an id.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, event_id)
);
-- One trial per identity (#1128): the row's existence IS the marker, so the
-- set-once arbiter is the primary key — an insert that loses means "already used".
CREATE TABLE IF NOT EXISTS user_trials (
  user_id TEXT NOT NULL PRIMARY KEY,
  used_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

export interface StartTrialInput {
  /** The identity consuming its one trial (#1128) — trials are per user, not per workspace. */
  userId: string;
  /** The freshly provisioned workspace the trial entitles. */
  workspaceId: string;
  /** The reference "now" (ISO) — injectable so tests are deterministic. Defaults to the wall clock. */
  now?: string;
}

/**
 * Input for a billing-driven entitlement write (PRD #1160 S5, #1165): the
 * transition already computed by `applyBillingEvent`/`billingStateFromSubscription`
 * plus the workspace it lands on. Billing always asserts `plan='premium'` and
 * lets the dates cap it — see `billing.ts` for the contract (#1135).
 */
export interface UpdateWorkspaceBillingInput extends WorkspaceBillingState {
  workspaceId: string;
}

/** Input for the admin premium palanca (PRD #1160 S4, #1164). */
export interface GrantPremiumInput {
  workspaceId: string;
  /**
   * Until when the grant holds (ISO), or null for an INDEFINITE grant — the
   * beta/comps/lifetime carril (#1133). `deriveEffectivePlan` honors the date
   * regardless of the declared plan, so a dated grant lapses on its own with no
   * expiry job; an indefinite one holds until an explicit revoke.
   */
  premiumUntil: string | null;
}

/**
 * Workspace entitlements (PRD #1160 S1, #1161): the stored `free|trial|premium`
 * row beside the grant, plus the set-once activation timestamps (#1131). The
 * control plane is the ONLY source of truth here — billing webhooks and the
 * admin palanca write it, every surface derives from it (`deriveEffectivePlan`),
 * and nothing queries the merchant-of-record on a hot path.
 */
export interface EntitlementDirectory {
  /**
   * The stored entitlement row, or null when none exists — which reads as
   * `free` with no trial consumed (the pre-#1161 migration story: existing
   * workspaces get no row and need no backfill).
   */
  readWorkspaceEntitlement(workspaceId: string): Promise<WorkspaceEntitlement | null>;
  /**
   * Start the identity's one trial for a freshly provisioned workspace (#1128):
   * atomically consume the per-user trial marker (set-once — an INSERT that
   * loses means the trial was already used, so re-provisioning NEVER re-trials)
   * and write the workspace's `trial` entitlement with its window. Returns the
   * entitlement, or null when this identity already used its trial.
   */
  startTrialIfUnused(input: StartTrialInput): Promise<WorkspaceEntitlement | null>;
  /**
   * Record that the workspace completed onboarding (#1131). Set-once: the first
   * call wins, every later call is a no-op — the timestamp says only THAT it
   * happened, never what the workspace holds.
   */
  markWorkspaceOnboarded(workspaceId: string, at: string): Promise<void>;
  /** Record that the workspace holds its first holding (#1131). Set-once, like `markWorkspaceOnboarded`. */
  markWorkspaceFirstHolding(workspaceId: string, at: string): Promise<void>;
  /** Every stored entitlement row — the /admin entitlements view (#1164). Order unspecified; callers join by workspace id. */
  listWorkspaceEntitlements(): Promise<WorkspaceEntitlement[]>;
  /**
   * The admin premium palanca (PRD #1160 S4, #1164): declare a workspace
   * `premium` with `premiumUntil` (a dated grant) or null (indefinite). Upsert —
   * creates the row for a workspace that never had one, or overwrites the plan
   * and window on an existing row, always preserving the set-once activation
   * timestamps and the trial marker. Returns the resulting row.
   */
  grantWorkspacePremium(input: GrantPremiumInput): Promise<WorkspaceEntitlement>;
  /**
   * Revoke a premium grant (#1164): drop the workspace back to `free` and clear
   * `premiumUntil`. A workspace with no row is already free, so this is a no-op
   * there. The trial marker and activation timestamps are left untouched — this
   * removes only the premium grant, never rewrites history.
   */
  revokeWorkspacePremium(workspaceId: string): Promise<void>;
  /**
   * Apply a billing transition (PRD #1160 S5, #1165): upsert the workspace onto
   * `plan='premium'` with the window and merchant-of-record references the
   * transition computed. Like the admin palanca, it preserves the trial marker
   * and the set-once activation timestamps — billing asserts the premium state
   * and its refs, never rewrites activation history. Returns the resulting row.
   */
  updateWorkspaceBilling(
    input: UpdateWorkspaceBillingInput,
  ): Promise<WorkspaceEntitlement>;
  /**
   * The webhook idempotency arbiter (#1135): record a provider event id,
   * returning true when this delivery is the FIRST (process it) and false on a
   * redelivery (skip it). Keyed per provider, so two MoRs can never collide.
   */
  recordBillingWebhookEvent(provider: string, eventId: string): Promise<boolean>;
}

function toWorkspaceEntitlement(row: Record<string, unknown>): WorkspaceEntitlement {
  const text = (column: string): string | null =>
    row[column] == null ? null : String(row[column]);
  return {
    workspaceId: String(row["workspace_id"]),
    plan: String(row["plan"]) as WorkspaceEntitlement["plan"],
    trialEndsAt: text("trial_ends_at"),
    premiumUntil: text("premium_until"),
    billingProvider: text("billing_provider"),
    billingCustomerId: text("billing_customer_id"),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status"),
    onboardedAt: text("onboarded_at"),
    firstHoldingAt: text("first_holding_at"),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export function createEntitlementDirectory(client: Client): EntitlementDirectory {
  return {
    async readWorkspaceEntitlement(workspaceId) {
      const result = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceEntitlement(result.rows[0]!) : null;
    },
    async startTrialIfUnused({ userId, workspaceId, now }) {
      const stamp = now ?? new Date().toISOString();
      // The per-identity marker is the arbiter (#1128): losing this insert means
      // the trial was already consumed — by an earlier workspace, or by the
      // concurrent provision that won — so there is nothing left to start.
      const consumed = await client.execute({
        sql: `INSERT INTO user_trials (user_id, used_at) VALUES (?, ?)
              ON CONFLICT(user_id) DO NOTHING`,
        args: [userId, stamp],
      });
      if (consumed.rowsAffected === 0) {
        return null;
      }
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, plan, trial_ends_at)
              VALUES (?, 'trial', ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                plan = 'trial',
                trial_ends_at = excluded.trial_ends_at,
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, trialEndsAtFrom(stamp)],
      });
      const created = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return toWorkspaceEntitlement(created.rows[0]!);
    },
    async markWorkspaceOnboarded(workspaceId, at) {
      // Set-once via COALESCE: the first stamp wins, later calls are no-ops.
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, onboarded_at)
              VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                onboarded_at = COALESCE(onboarded_at, excluded.onboarded_at),
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, at],
      });
    },
    async markWorkspaceFirstHolding(workspaceId, at) {
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, first_holding_at)
              VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                first_holding_at = COALESCE(first_holding_at, excluded.first_holding_at),
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, at],
      });
    },
    async listWorkspaceEntitlements() {
      const result = await client.execute("SELECT * FROM workspace_entitlements");
      return result.rows.map((row) => toWorkspaceEntitlement(row));
    },
    async grantWorkspacePremium({ workspaceId, premiumUntil }) {
      // Upsert onto plan='premium' with the (possibly null → indefinite) window,
      // leaving the trial marker and set-once timestamps intact — a grant only
      // asserts the premium state, it never rewrites activation history.
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (workspace_id, plan, premium_until)
              VALUES (?, 'premium', ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                plan = 'premium',
                premium_until = excluded.premium_until,
                updated_at = CURRENT_TIMESTAMP`,
        args: [workspaceId, premiumUntil],
      });
      const created = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return toWorkspaceEntitlement(created.rows[0]!);
    },
    async updateWorkspaceBilling({
      workspaceId,
      premiumUntil,
      billingProvider,
      billingCustomerId,
      subscriptionId,
      subscriptionStatus,
    }) {
      // Mirrors grantWorkspacePremium's upsert shape: assert plan='premium'
      // plus the MoR refs, leave trial + activation history untouched (#1165).
      await client.execute({
        sql: `INSERT INTO workspace_entitlements (
                workspace_id, plan, premium_until, billing_provider,
                billing_customer_id, subscription_id, subscription_status)
              VALUES (?, 'premium', ?, ?, ?, ?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                plan = 'premium',
                premium_until = excluded.premium_until,
                billing_provider = excluded.billing_provider,
                billing_customer_id = excluded.billing_customer_id,
                subscription_id = excluded.subscription_id,
                subscription_status = excluded.subscription_status,
                updated_at = CURRENT_TIMESTAMP`,
        args: [
          workspaceId,
          premiumUntil,
          billingProvider,
          billingCustomerId,
          subscriptionId,
          subscriptionStatus,
        ],
      });
      const updated = await client.execute({
        sql: "SELECT * FROM workspace_entitlements WHERE workspace_id = ?",
        args: [workspaceId],
      });
      return toWorkspaceEntitlement(updated.rows[0]!);
    },
    async recordBillingWebhookEvent(provider, eventId) {
      // Losing the insert means the event id was already processed (#1135).
      const result = await client.execute({
        sql: `INSERT INTO billing_webhook_events (provider, event_id)
              VALUES (?, ?)
              ON CONFLICT(provider, event_id) DO NOTHING`,
        args: [provider, eventId],
      });
      return result.rowsAffected > 0;
    },
    async revokeWorkspacePremium(workspaceId) {
      // No INSERT: a workspace with no row is already free. Touch only the
      // premium fields, so a live trial (its own column) and the activation
      // timestamps survive the revoke.
      await client.execute({
        sql: `UPDATE workspace_entitlements
              SET plan = 'free', premium_until = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE workspace_id = ?`,
        args: [workspaceId],
      });
    },
  };
}
