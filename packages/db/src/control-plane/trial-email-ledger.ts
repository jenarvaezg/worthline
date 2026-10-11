import type { Client } from "@libsql/client";

/**
 * Tables owned by the trial-email port (#1173, PRD #1171 S2): the set-once mark
 * of each trial email per identity, and the identity's email preferences.
 *
 * Keyed by USER, not workspace, because the trial is per identity (#1128): one
 * identity gets at most one welcome, one reminder and one expiry notice, ever —
 * a re-provisioned workspace inherits neither a second trial nor a second email.
 *
 * The port reads and writes ONLY these two tables (ADR 0087): who is in a trial
 * window comes from the entitlement port, and whose address it is from tenancy;
 * the web side composes the three.
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

/** What this port knows about one identity: its marks and its preference. */
export interface TrialEmailMarks {
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
 * The trial-email ledger (#1173): the marks that guarantee no email of the cycle
 * goes out twice, and the identity's «no recibir recordatorios». The send itself
 * lives in the web app; this port only answers «is it still mine to send?».
 */
export interface TrialEmailLedger {
  /** The identity's marks and preference — empty marks and null when it has none. */
  readTrialEmailMarks(userId: string): Promise<TrialEmailMarks>;
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

export function createTrialEmailLedger(client: Client): TrialEmailLedger {
  return {
    async readTrialEmailMarks(userId) {
      const sends = await client.execute({
        sql: "SELECT kind FROM trial_email_sends WHERE user_id = ?",
        args: [userId],
      });
      const preference = await client.execute({
        sql: "SELECT trial_reminders_opted_out_at FROM email_preferences WHERE user_id = ?",
        args: [userId],
      });
      const optedOut = preference.rows[0]?.["trial_reminders_opted_out_at"];
      return {
        claimedKinds: sends.rows
          .map((row) => String(row["kind"]))
          .filter(isTrialEmailKind),
        remindersOptedOutAt: optedOut == null ? null : String(optedOut),
      };
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
