import type { Client } from "@libsql/client";

/**
 * Table owned by the daily-provisioning-cap port (#1175, PRD #1171 S4): how many
 * fresh workspaces each UTC day has provisioned. One tiny row per day that saw a
 * sign-up; rows self-expire by day key, so there is no sweep. Aggregate only — no
 * email, no user id, nothing that says WHO was provisioned (#1131).
 */
export const DAILY_PROVISIONING_CAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_provisioning_cap (
  day_key TEXT PRIMARY KEY,
  provisioned_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** The outcome of asking the day's cap to admit one more workspace (#1175). */
export interface DailyProvisioningClaim {
  /** True when the caller may now create a workspace. */
  admitted: boolean;
  /** Workspaces the day has provisioned after this claim (the limit, on a refusal). */
  provisionedToday: number;
}

/**
 * The **daily provisioning cap** (CONTEXT.md; #1175): the fuse #733 left as the
 * future of open registration. Every serverless instance shares it through the
 * control plane, so the decision cannot live in process memory (ADR 0051's
 * reasoning).
 *
 * It meters NEW workspaces only. Nothing here knows about sign-ins: the
 * provisioner claims after it has established that the identity owns no
 * workspace yet, so an existing user's login never reaches this port.
 */
export interface DailyProvisioningCap {
  /**
   * Count one more workspace for `dayKey` when fewer than `limit` are counted.
   * The check and the increment are ONE statement, so two instances racing for
   * the last place cannot both be admitted — SQLite (and Turso over HTTP) runs
   * a single statement atomically. A refusal writes nothing; a limit of zero
   * refuses outright.
   */
  claimDailyProvisioning(dayKey: string, limit: number): Promise<DailyProvisioningClaim>;
  /**
   * Take back one admitted workspace from the day it was CLAIMED on — the
   * caller passes that day, so a provision that straddles midnight gives back
   * yesterday's place, not today's. For a claim that did not end up creating a
   * workspace (it failed, or it lost the same-identity race of #733). Never
   * drops below zero.
   */
  releaseDailyProvisioning(dayKey: string): Promise<void>;
}

export function createDailyProvisioningCap(
  client: Pick<Client, "execute">,
): DailyProvisioningCap {
  async function provisionedOn(dayKey: string): Promise<number> {
    const result = await client.execute({
      sql: "SELECT provisioned_count FROM daily_provisioning_cap WHERE day_key = ?",
      args: [dayKey],
    });
    return Number(result.rows[0]?.["provisioned_count"] ?? 0);
  }

  return {
    async claimDailyProvisioning(dayKey, limit) {
      // The INSERT would open the day at 1, which a closed (zero) cap must not.
      if (limit <= 0) {
        return { admitted: false, provisionedToday: await provisionedOn(dayKey) };
      }
      // Conditional upsert: the DO UPDATE only fires while under the limit, and
      // RETURNING yields a row only when a write happened — no row = refused.
      const result = await client.execute({
        sql: `INSERT INTO daily_provisioning_cap (day_key, provisioned_count)
              VALUES (?, 1)
              ON CONFLICT(day_key) DO UPDATE SET
                provisioned_count = provisioned_count + 1,
                updated_at = CURRENT_TIMESTAMP
              WHERE provisioned_count < ?
              RETURNING provisioned_count`,
        args: [dayKey, limit],
      });
      const row = result.rows[0];
      if (row) {
        return { admitted: true, provisionedToday: Number(row["provisioned_count"]) };
      }
      return { admitted: false, provisionedToday: await provisionedOn(dayKey) };
    },
    async releaseDailyProvisioning(dayKey) {
      await client.execute({
        sql: `UPDATE daily_provisioning_cap
              SET provisioned_count = provisioned_count - 1,
                  updated_at = CURRENT_TIMESTAMP
              WHERE day_key = ? AND provisioned_count > 0`,
        args: [dayKey],
      });
    },
  };
}
