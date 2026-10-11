import type { Client } from "@libsql/client";

/**
 * Table owned by the provisioning-quota port (#1175, PRD #1171 S4): how many
 * fresh workspaces each UTC day has handed out. One tiny row per day that saw a
 * sign-up; rows self-expire by day key, so there is no sweep. Aggregate only — no
 * email, no user id, nothing that says WHO was provisioned (#1131).
 */
export const PROVISIONING_QUOTA_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_provision_quota (
  day_key TEXT PRIMARY KEY,
  granted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** The outcome of asking for one of the day's provisioning slots (#1175). */
export interface ProvisionSlotClaim {
  /** True when this caller now holds a slot and may create a workspace. */
  granted: boolean;
  /** The day's running count after the claim (equal to the cap on a refusal). */
  used: number;
}

/**
 * The daily provisioning cap (#1175): the fuse #733 left as the future of open
 * registration. Every serverless instance shares it through the control plane,
 * so the decision cannot live in process memory (ADR 0051's reasoning).
 *
 * It meters NEW workspaces only. Nothing here knows about sign-ins: the
 * provisioner asks for a slot after it has established that the identity owns no
 * workspace yet, so an existing user's login never reaches this port.
 */
export interface ProvisioningQuota {
  /**
   * Take one of `dayKey`'s slots when fewer than `dailyCap` are taken. The check
   * and the increment are ONE statement, so two instances racing for the last
   * slot cannot both win — SQLite (and Turso over HTTP) runs a single statement
   * atomically. A refusal writes nothing. A cap of zero refuses outright.
   */
  claimWorkspaceProvisionSlot(
    dayKey: string,
    dailyCap: number,
  ): Promise<ProvisionSlotClaim>;
  /**
   * Hand a slot back to the day it was CLAIMED on — the caller passes that day,
   * so a provision that straddles midnight returns yesterday's slot, not
   * today's. For a provision that did not end up creating a workspace (it failed,
   * or it lost the same-identity race of #733). Never drops below zero.
   */
  releaseWorkspaceProvisionSlot(dayKey: string): Promise<void>;
  /** The day's running count; zero for a day with no row. */
  readWorkspaceProvisionCount(dayKey: string): Promise<number>;
}

export function createProvisioningQuota(
  client: Pick<Client, "execute">,
): ProvisioningQuota {
  async function readCount(dayKey: string): Promise<number> {
    const result = await client.execute({
      sql: "SELECT granted FROM workspace_provision_quota WHERE day_key = ?",
      args: [dayKey],
    });
    return Number(result.rows[0]?.["granted"] ?? 0);
  }

  return {
    async claimWorkspaceProvisionSlot(dayKey, dailyCap) {
      // The INSERT would open the day at 1, which a closed (zero) cap must not.
      if (dailyCap <= 0) {
        return { granted: false, used: await readCount(dayKey) };
      }
      // Conditional upsert: the DO UPDATE only fires while under the cap, and
      // RETURNING yields a row only when a write happened — no row = refused.
      const result = await client.execute({
        sql: `INSERT INTO workspace_provision_quota (day_key, granted)
              VALUES (?, 1)
              ON CONFLICT(day_key) DO UPDATE SET
                granted = granted + 1,
                updated_at = CURRENT_TIMESTAMP
              WHERE granted < ?
              RETURNING granted`,
        args: [dayKey, dailyCap],
      });
      const row = result.rows[0];
      if (row) {
        return { granted: true, used: Number(row["granted"]) };
      }
      return { granted: false, used: await readCount(dayKey) };
    },
    async releaseWorkspaceProvisionSlot(dayKey) {
      await client.execute({
        sql: `UPDATE workspace_provision_quota
              SET granted = granted - 1, updated_at = CURRENT_TIMESTAMP
              WHERE day_key = ? AND granted > 0`,
        args: [dayKey],
      });
    },
    readWorkspaceProvisionCount: readCount,
  };
}
