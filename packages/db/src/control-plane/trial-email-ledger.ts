import type { EntitlementPlan } from "@db/entitlements";
import type { Client } from "@libsql/client";

/**
 * Tables owned by the trial-email port (#1173, PRD #1171 S2): the set-once mark
 * of each trial email per identity, and the identity's email preferences.
 *
 * Keyed by USER, not workspace, because the trial is per identity (#1128): one
 * identity gets at most one welcome, one reminder and one expiry notice, ever —
 * a re-provisioned workspace inherits neither a second trial nor a second email.
 */
export const TRIAL_EMAIL_SCHEMA = `
-- One row per (identity, email kind). The row's existence IS the claim: an
-- insert that loses means another pass already took it. \`sent_at\` stays null
-- until the provider accepted the mail; only an unsent claim can be released.
CREATE TABLE IF NOT EXISTS trial_email_sends (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  provider_message_id TEXT,
  PRIMARY KEY (user_id, kind),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
-- What an identity asked NOT to receive. Columns, not rows per preference: there
-- is exactly one today (the trial reminders), and a null means «sí, envíalos».
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id TEXT NOT NULL PRIMARY KEY,
  trial_reminders_opted_out_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

/** The three emails of the trial cycle (#1173) — the receipt is the MoR's, not ours. */
export const TRIAL_EMAIL_KINDS = ["welcome", "trial_reminder", "trial_expired"] as const;
export type TrialEmailKind = (typeof TRIAL_EMAIL_KINDS)[number];

/**
 * One trialing identity and everything the emails need to decide and to write:
 * where to send, the window, what the workspace is entitled to now (so the
 * caller derives the effective plan with `deriveEffectivePlan`), which kinds are
 * already claimed and whether the reminders were declined.
 */
export interface TrialEmailCandidate {
  userId: string;
  email: string;
  workspaceId: string;
  /** When the identity consumed its trial (`user_trials.used_at`). */
  trialStartedAt: string;
  trialEndsAt: string;
  plan: EntitlementPlan;
  premiumUntil: string | null;
  /** Kinds with a claim row — sent, or taken by a pass that never confirmed. */
  claimedKinds: TrialEmailKind[];
  /** When the identity declined the trial reminders, or null. */
  remindersOptedOutAt: string | null;
}

export interface TrialEmailClaim {
  userId: string;
  kind: TrialEmailKind;
}

/**
 * The trial-email ledger (#1173): who is in a trial window, and the marks that
 * guarantee no email of the cycle goes out twice. The send itself lives in the
 * web app; this port only answers «is it still mine to send?».
 */
export interface TrialEmailLedger {
  /**
   * Every owner whose trial closes after `trialEndsAfter` (ISO), oldest window
   * first. The cutoff is what keeps a first deploy, or a long outage, from
   * mailing trials that ended weeks ago.
   */
  listTrialEmailCandidates(input: {
    trialEndsAfter: string;
  }): Promise<TrialEmailCandidate[]>;
  /**
   * Take the right to send `kind` to this identity. True when this call won;
   * false when the mark already exists (sent, or claimed by another pass).
   * Claim BEFORE sending: two overlapping passes can never both mail.
   */
  claimTrialEmail(input: TrialEmailClaim & { at: string }): Promise<boolean>;
  /** Record that the provider accepted the claimed mail. */
  confirmTrialEmail(
    input: TrialEmailClaim & { at: string; providerMessageId: string },
  ): Promise<void>;
  /**
   * Give an UNSENT claim back after a failed send, so a later pass can retry.
   * A confirmed send is never released — no-op there.
   */
  releaseTrialEmail(input: TrialEmailClaim): Promise<void>;
  /**
   * «No recibir recordatorios»: the identity declines the trial reminders (the
   * day-2 notice and the expiry notice; never the welcome, which is already
   * sent by then). Set-once: the first stamp stays.
   */
  optOutOfTrialReminders(input: { userId: string; at: string }): Promise<void>;
}

function isTrialEmailKind(value: string): value is TrialEmailKind {
  return (TRIAL_EMAIL_KINDS as readonly string[]).includes(value);
}

function toCandidate(row: Record<string, unknown>): TrialEmailCandidate {
  const claimed = row["claimed_kinds"] == null ? "" : String(row["claimed_kinds"]);
  return {
    claimedKinds: claimed.split(",").filter(isTrialEmailKind),
    email: String(row["email"]),
    plan: String(row["plan"]) as EntitlementPlan,
    premiumUntil: row["premium_until"] == null ? null : String(row["premium_until"]),
    remindersOptedOutAt:
      row["trial_reminders_opted_out_at"] == null
        ? null
        : String(row["trial_reminders_opted_out_at"]),
    trialEndsAt: String(row["trial_ends_at"]),
    trialStartedAt: String(row["used_at"]),
    userId: String(row["user_id"]),
    workspaceId: String(row["workspace_id"]),
  };
}

export function createTrialEmailLedger(client: Client): TrialEmailLedger {
  return {
    async listTrialEmailCandidates({ trialEndsAfter }) {
      // ISO-8601 UTC strings from `toISOString()` compare correctly as text.
      const result = await client.execute({
        sql: `SELECT we.workspace_id, we.plan, we.trial_ends_at, we.premium_until,
                     u.id AS user_id, u.email, ut.used_at,
                     ep.trial_reminders_opted_out_at,
                     (SELECT group_concat(s.kind, ',') FROM trial_email_sends s
                       WHERE s.user_id = u.id) AS claimed_kinds
              FROM workspace_entitlements we
              JOIN grants g ON g.workspace_id = we.workspace_id AND g.role = 'owner'
              JOIN users u ON u.id = g.user_id
              JOIN user_trials ut ON ut.user_id = u.id
              LEFT JOIN email_preferences ep ON ep.user_id = u.id
              WHERE we.trial_ends_at IS NOT NULL AND we.trial_ends_at > ?
              ORDER BY we.trial_ends_at, u.id`,
        args: [trialEndsAfter],
      });
      return result.rows.map((row) => toCandidate(row));
    },
    async claimTrialEmail({ userId, kind, at }) {
      const result = await client.execute({
        sql: `INSERT INTO trial_email_sends (user_id, kind, claimed_at)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, kind) DO NOTHING`,
        args: [userId, kind, at],
      });
      return result.rowsAffected > 0;
    },
    async confirmTrialEmail({ userId, kind, at, providerMessageId }) {
      await client.execute({
        sql: `UPDATE trial_email_sends SET sent_at = ?, provider_message_id = ?
              WHERE user_id = ? AND kind = ?`,
        args: [at, providerMessageId, userId, kind],
      });
    },
    async releaseTrialEmail({ userId, kind }) {
      await client.execute({
        sql: `DELETE FROM trial_email_sends
              WHERE user_id = ? AND kind = ? AND sent_at IS NULL`,
        args: [userId, kind],
      });
    },
    async optOutOfTrialReminders({ userId, at }) {
      await client.execute({
        sql: `INSERT INTO email_preferences (user_id, trial_reminders_opted_out_at)
              VALUES (?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                trial_reminders_opted_out_at =
                  COALESCE(trial_reminders_opted_out_at, excluded.trial_reminders_opted_out_at),
                updated_at = CURRENT_TIMESTAMP`,
        args: [userId, at],
      });
    },
  };
}
