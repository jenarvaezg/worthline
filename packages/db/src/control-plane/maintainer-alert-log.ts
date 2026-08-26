import type { Client } from "@libsql/client";

/** Tables owned by the maintainer-alert port (#1050, ADR 0064). */
export const MAINTAINER_ALERT_SCHEMA = `
CREATE TABLE IF NOT EXISTS maintainer_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  holding_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolution_note TEXT,
  resolution_link TEXT,
  resolved_at TEXT,
  supersedes_alert_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- At most one OPEN alert per (workspace, holding, category): the arbiter for the
-- dedup contract. Partial so a closed alert never blocks a fresh (regression) one.
CREATE UNIQUE INDEX IF NOT EXISTS maintainer_alerts_one_open_per_key
  ON maintainer_alerts(workspace_id, holding_id, category) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS maintainer_alerts_recency
  ON maintainer_alerts(last_seen_at);
CREATE TABLE IF NOT EXISTS maintainer_alert_occurrences (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (alert_id) REFERENCES maintainer_alerts(id)
);
CREATE INDEX IF NOT EXISTS maintainer_alert_occurrences_alert
  ON maintainer_alert_occurrences(alert_id);
`;

/**
 * The maintainer-alert categories (#1050, ADR 0064). The first three are the
 * assistant's — `infidelity`: the painted/persisted figure diverges from the
 * engine's recomputation (the #1042 class of bug); `residual`: an unexplained
 * residual above the documented modeling tolerance after normalizing and
 * verifying config; `sync_source`: the smell is a connected-source/sync
 * ownership problem, not a worthline calc bug.
 *
 * `missed_capture` (#1339) is the one category NO model can raise: the
 * daily-capture cron raises it about ITSELF when the ledger shows an expected
 * pass that never finalized (Vercel Cron is best-effort and skips invocations).
 * It is fleet-wide, so it carries sentinel workspace/holding ids rather than a
 * tenant's — see the raiser for the contract.
 */
export type MaintainerAlertCategory =
  | "infidelity"
  | "missed_capture"
  | "residual"
  | "sync_source";

/** An alert's lifecycle state (#1050): `open` accumulates occurrences; `resolved`/`dismissed` close it. */
export type MaintainerAlertStatus = "open" | "resolved" | "dismissed";

/**
 * One recorded occurrence of a maintainer alert (#1050). Every occurrence carries
 * the FULL forensic payload as opaque JSON — the store never inspects it, so it
 * stays decoupled from the agent-view calculation-trace shape it embeds.
 */
export interface MaintainerAlertOccurrence {
  id: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * A maintainer alert (#1050, decision #1038, ADR 0064): a suspected-bug signal
 * the assistant raised, stored ENTIRELY in the control plane so no workspace
 * export can drag maintainer material out. Dedup key is
 * `workspace_id + holding_id + category`: while one is `open` a re-raise
 * accumulates an occurrence; once closed, a re-raise mints a NEW alert linked
 * back via {@link supersedesAlertId} (it smells like a regression).
 */
export interface MaintainerAlert {
  id: string;
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  status: MaintainerAlertStatus;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionNote: string | null;
  resolutionLink: string | null;
  resolvedAt: string | null;
  /** The prior closed alert of the same key this one supersedes (regression link), or null. */
  supersedesAlertId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An alert with every occurrence's forensic payload — the `/admin` detail read (#1050). */
export interface MaintainerAlertWithOccurrences extends MaintainerAlert {
  occurrences: MaintainerAlertOccurrence[];
}

export interface RaiseMaintainerAlertInput {
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  /** The forensic payload (config snapshot, calculation trace, declared figure, …); stored verbatim as JSON. */
  payload: unknown;
  /** When the occurrence happened, as ISO; defaults to now. */
  occurredAt?: string;
}

/** The outcome of raising an alert (#1050): the resulting alert and whether a new row was minted. */
export interface RaisedMaintainerAlert {
  alert: MaintainerAlert;
  /** True when a NEW alert was created (first of its key, or a regression after closure). */
  created: boolean;
}

export interface UpdateMaintainerAlertStatusInput {
  status: Exclude<MaintainerAlertStatus, "open">;
  note?: string;
  link?: string;
}

/** Maintainer alert log (#1050, ADR 0064) — the `/admin` alerts surface. */
export interface MaintainerAlertLog {
  /**
   * Raise a maintainer alert (#1050, ADR 0064). Dedup by
   * `workspaceId + holdingId + category`: an existing OPEN alert of that key
   * accumulates a new occurrence; otherwise a fresh alert is minted, linked to
   * the most recent closed alert of the same key (regression) when one exists.
   */
  raiseMaintainerAlert(input: RaiseMaintainerAlertInput): Promise<RaisedMaintainerAlert>;
  /** Every alert across all workspaces, most-recently-seen first (the `/admin` list). */
  listMaintainerAlerts(): Promise<MaintainerAlert[]>;
  /** One alert with every occurrence's forensic payload, or null when unknown. */
  getMaintainerAlert(alertId: string): Promise<MaintainerAlertWithOccurrences | null>;
  /** Close an alert (`resolved`/`dismissed`) with an optional note/link. Throws when unknown. */
  updateMaintainerAlertStatus(
    alertId: string,
    input: UpdateMaintainerAlertStatusInput,
  ): Promise<MaintainerAlert>;
  /** Count of currently-open alerts — the `/admin` badge. */
  countOpenMaintainerAlerts(): Promise<number>;
}

function toMaintainerAlert(row: Record<string, unknown>): MaintainerAlert {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    holdingId: String(row["holding_id"]),
    category: String(row["category"]) as MaintainerAlertCategory,
    status: String(row["status"]) as MaintainerAlertStatus,
    occurrenceCount: Number(row["occurrence_count"]),
    firstSeenAt: String(row["first_seen_at"]),
    lastSeenAt: String(row["last_seen_at"]),
    resolutionNote:
      row["resolution_note"] == null ? null : String(row["resolution_note"]),
    resolutionLink:
      row["resolution_link"] == null ? null : String(row["resolution_link"]),
    resolvedAt: row["resolved_at"] == null ? null : String(row["resolved_at"]),
    supersedesAlertId:
      row["supersedes_alert_id"] == null ? null : String(row["supersedes_alert_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toMaintainerAlertOccurrence(
  row: Record<string, unknown>,
): MaintainerAlertOccurrence {
  return {
    id: String(row["id"]),
    payload: JSON.parse(String(row["payload_json"])),
    occurredAt: String(row["occurred_at"]),
  };
}

/** True when an INSERT lost the race for the one-open-alert-per-key index (#1050). */
function isOpenKeyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*maintainer_alerts/i.test(message);
}

export function createMaintainerAlertLog(
  client: Client,
  newId: () => string,
): MaintainerAlertLog {
  /**
   * One pass of {@link MaintainerAlertLog.raiseMaintainerAlert}: accumulate onto
   * the open alert of this key, or mint a fresh one (linked to the prior closed
   * alert as a regression). Occurrence count is recomputed from the actual rows
   * rather than incremented, so a crash between the two writes self-heals on the
   * next raise instead of drifting.
   */
  async function raiseMaintainerAlertOnce({
    workspaceId,
    holdingId,
    category,
    payload,
    occurredAt,
  }: RaiseMaintainerAlertInput): Promise<RaisedMaintainerAlert> {
    const stamp = occurredAt ?? new Date().toISOString();
    const payloadJson = JSON.stringify(payload ?? null);

    const open = await client.execute({
      sql: `SELECT * FROM maintainer_alerts
            WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status = 'open'
            LIMIT 1`,
      args: [workspaceId, holdingId, category],
    });

    if (open.rows.length > 0) {
      const alertId = String(open.rows[0]!["id"]);
      await client.execute({
        sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
              VALUES (?, ?, ?, ?)`,
        args: [newId(), alertId, payloadJson, stamp],
      });
      await client.execute({
        sql: `UPDATE maintainer_alerts SET
                occurrence_count = (
                  SELECT COUNT(*) FROM maintainer_alert_occurrences WHERE alert_id = ?
                ),
                last_seen_at = MAX(last_seen_at, ?),
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [alertId, stamp, alertId],
      });
      const reread = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return { alert: toMaintainerAlert(reread.rows[0]!), created: false };
    }

    // No open alert of this key: mint a fresh one, linked to the most recent
    // closed alert of the same key (a re-trigger after closure smells like a
    // regression — #1050).
    const priorClosed = await client.execute({
      sql: `SELECT id FROM maintainer_alerts
            WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status != 'open'
            ORDER BY last_seen_at DESC, rowid DESC
            LIMIT 1`,
      args: [workspaceId, holdingId, category],
    });
    const supersedesAlertId =
      priorClosed.rows.length > 0 ? String(priorClosed.rows[0]!["id"]) : null;

    const alertId = newId();
    await client.execute({
      sql: `INSERT INTO maintainer_alerts (
              id, workspace_id, holding_id, category, status, occurrence_count,
              first_seen_at, last_seen_at, supersedes_alert_id
            ) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?)`,
      args: [alertId, workspaceId, holdingId, category, stamp, stamp, supersedesAlertId],
    });
    await client.execute({
      sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
            VALUES (?, ?, ?, ?)`,
      args: [newId(), alertId, payloadJson, stamp],
    });
    const created = await client.execute({
      sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
      args: [alertId],
    });
    return { alert: toMaintainerAlert(created.rows[0]!), created: true };
  }

  return {
    async raiseMaintainerAlert(input) {
      // The open-lookup and the fresh-alert INSERT are two statements: two
      // concurrent raises of the same not-yet-open key can both read "no open
      // row", and the second INSERT then trips `maintainer_alerts_one_open_per_key`.
      // That is the losing raise's cue to accumulate onto the winner's row, not
      // to fail — so a unique violation retries exactly once, where the open
      // lookup now sees the row the winner just minted.
      try {
        return await raiseMaintainerAlertOnce(input);
      } catch (error) {
        if (isOpenKeyConflict(error)) {
          return await raiseMaintainerAlertOnce(input);
        }
        throw error;
      }
    },
    async listMaintainerAlerts() {
      const result = await client.execute(
        `SELECT * FROM maintainer_alerts ORDER BY last_seen_at DESC, rowid DESC`,
      );
      return result.rows.map((row) => toMaintainerAlert(row));
    },
    async getMaintainerAlert(alertId) {
      const alert = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (alert.rows.length === 0) return null;
      const occurrences = await client.execute({
        sql: `SELECT id, alert_id, payload_json, occurred_at
              FROM maintainer_alert_occurrences
              WHERE alert_id = ?
              ORDER BY occurred_at ASC, rowid ASC`,
        args: [alertId],
      });
      return {
        ...toMaintainerAlert(alert.rows[0]!),
        occurrences: occurrences.rows.map((row) => toMaintainerAlertOccurrence(row)),
      };
    },
    async updateMaintainerAlertStatus(alertId, { status, note, link }) {
      const existing = await client.execute({
        sql: "SELECT id FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (existing.rows.length === 0) {
        throw new Error("Maintainer alert not found.");
      }
      await client.execute({
        sql: `UPDATE maintainer_alerts SET
                status = ?,
                resolution_note = ?,
                resolution_link = ?,
                resolved_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [status, note ?? null, link ?? null, alertId],
      });
      const updated = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return toMaintainerAlert(updated.rows[0]!);
    },
    async countOpenMaintainerAlerts() {
      const result = await client.execute(
        "SELECT COUNT(*) AS count FROM maintainer_alerts WHERE status = 'open'",
      );
      return Number(result.rows[0]?.["count"] ?? 0);
    },
  };
}
