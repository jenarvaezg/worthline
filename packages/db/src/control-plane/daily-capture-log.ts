import type { Client } from "@libsql/client";

/** The table owned by the daily-capture port (ADR 0037, #895). */
export const DAILY_CAPTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_capture_runs (
  date_key TEXT PRIMARY KEY,
  finalized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** Daily fleet-capture idempotency ledger (ADR 0037, #895). */
export interface DailyCaptureLog {
  /**
   * Whether this fleet-capture pass has already finalized. The key is an opaque
   * run key, not a bare calendar date: since #895 it is pass-qualified
   * (`YYYY-MM-DD:am|pm`) so the morning and evening passes finalize
   * independently — do not query this table by a plain date and expect a match.
   */
  hasDailyCaptureRun(runKey: string): Promise<boolean>;
  /** Record or update this fleet-capture pass's finalization (see `hasDailyCaptureRun`). */
  recordDailyCaptureRun(runKey: string, finalizedAt: string): Promise<void>;
}

export function createDailyCaptureLog(client: Client): DailyCaptureLog {
  return {
    async hasDailyCaptureRun(dateKey) {
      const result = await client.execute({
        sql: "SELECT 1 FROM daily_capture_runs WHERE date_key = ? LIMIT 1",
        args: [dateKey],
      });
      return result.rows.length > 0;
    },
    async recordDailyCaptureRun(dateKey, finalizedAt) {
      await client.execute({
        sql: `INSERT INTO daily_capture_runs (date_key, finalized_at)
              VALUES (?, ?)
              ON CONFLICT(date_key) DO UPDATE SET
                finalized_at = excluded.finalized_at,
                updated_at = CURRENT_TIMESTAMP`,
        args: [dateKey, finalizedAt],
      });
    },
  };
}
