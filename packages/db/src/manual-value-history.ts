import type { ManualValuePoint } from "@worthline/domain";
import { asc } from "drizzle-orm";

import { auditLog } from "./schema";
import type { StoreDb } from "./store-context";

/**
 * Reconstruct the audit history of manual values/balances, keyed by holding id.
 *
 * Each `update_valuation` / `update_balance` audit entry is a dated value point;
 * the entry's `created_at` date is when the value became known (PRD #107).
 */
export async function readManualValueHistory(
  db: StoreDb,
): Promise<Map<string, ManualValuePoint[]>> {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

  const history = new Map<string, ManualValuePoint[]>();

  for (const row of rows) {
    if (row.action !== "update_valuation" && row.action !== "update_balance") {
      continue;
    }

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

  return history;
}
