import type { ManualValuePoint } from "@worthline/domain";
import { and, asc, inArray } from "drizzle-orm";

import { chunk } from "./chunk";
import { auditLog } from "./schema";
import type { StoreDb } from "./store-context";

const MANUAL_VALUE_ACTIONS = ["update_valuation", "update_balance"] as const;

/** Stay well under SQLite's per-statement bind cap (same order as snapshot IN lists). */
const ENTITY_IDS_PER_QUERY = 200;

/**
 * Reconstruct the audit history of manual values/balances, keyed by holding id.
 *
 * Each `update_valuation` / `update_balance` audit entry is a dated value point;
 * the entry's `created_at` date is when the value became known (PRD #107).
 *
 * Callers pass the holding ids they will look up (#1534). The query filters
 * `entity_id` + action in SQL so it can use `audit_log_entity_created_idx`
 * instead of transferring the whole log (which grows with every user write).
 */
export async function readManualValueHistory(
  db: StoreDb,
  entityIds: readonly string[],
): Promise<Map<string, ManualValuePoint[]>> {
  const history = new Map<string, ManualValuePoint[]>();
  const uniqueIds = [...new Set(entityIds)];
  if (uniqueIds.length === 0) return history;

  for (const ids of chunk(uniqueIds, ENTITY_IDS_PER_QUERY)) {
    const rows = await db
      .select({
        action: auditLog.action,
        createdAt: auditLog.createdAt,
        detailsJson: auditLog.detailsJson,
        entityId: auditLog.entityId,
      })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.entityId, ids),
          inArray(auditLog.action, [...MANUAL_VALUE_ACTIONS]),
        ),
      )
      .orderBy(asc(auditLog.entityId), asc(auditLog.createdAt))
      .all();

    for (const row of rows) {
      let details: Record<string, unknown>;
      try {
        details = JSON.parse(row.detailsJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const value =
        row.action === "update_valuation"
          ? details["currentValueMinor"]
          : details["balanceMinor"];

      if (typeof value !== "number") {
        continue;
      }

      const dateKey = (row.createdAt ?? "").slice(0, 10);
      if (!dateKey) {
        continue;
      }

      const points = history.get(row.entityId) ?? [];
      points.push({ dateKey, valueMinor: value });
      history.set(row.entityId, points);
    }
  }

  return history;
}
