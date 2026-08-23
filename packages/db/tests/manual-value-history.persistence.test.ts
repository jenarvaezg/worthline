/**
 * Windowed manual-value audit reads (#1534).
 *
 * The dashboard health signal (and historical reconstruction) used to SELECT the
 * entire `audit_log`, including `details_json`, and filter `update_valuation` /
 * `update_balance` in JS. That scan grows with every write the user ever makes.
 *
 * This test pins the FIX at two levels:
 *   1. READ SHAPE — the query filters by `entity_id` + action in SQL, so
 *      `EXPLAIN QUERY PLAN` resolves it through `audit_log_entity_created_idx`
 *      instead of a bare full scan of `audit_log`.
 *   2. BEHAVIOR — with a POPULATED log (many unrelated create/update rows), the
 *      history for the asked holdings is identical to filtering the full audit
 *      log in memory, so the health signal's input does not move.
 */

import type { AuditLogEntry } from "@db/index";
import { openLibsqlClient } from "@db/index";
import { migrate } from "@db/migrate";
import {
  createInMemoryStore,
  createStoreFromSqlite,
  type PersistenceTestStore,
} from "@db/testing";
import type { Client, InValue } from "@libsql/client";
import type { ManualValuePoint } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const NOISE_HOLDINGS = 40;

async function queryPlan(
  client: Client,
  sql: string,
  ...params: InValue[]
): Promise<string> {
  const rows = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: params }))
    .rows as unknown as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join("\n");
}

function historyFromFullLog(
  log: readonly AuditLogEntry[],
  entityIds: ReadonlySet<string>,
): Map<string, ManualValuePoint[]> {
  const history = new Map<string, ManualValuePoint[]>();
  const chronological = [...log].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const entry of chronological) {
    if (!entityIds.has(entry.entityId)) continue;
    if (entry.action !== "update_valuation" && entry.action !== "update_balance") {
      continue;
    }
    const value =
      entry.action === "update_valuation"
        ? entry.details["currentValueMinor"]
        : entry.details["balanceMinor"];
    if (typeof value !== "number") continue;
    const dateKey = entry.createdAt.slice(0, 10);
    if (!dateKey) continue;
    const points = history.get(entry.entityId) ?? [];
    points.push({ dateKey, valueMinor: value });
    history.set(entry.entityId, points);
  }
  return history;
}

async function seedPopulatedLog(store: PersistenceTestStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });

  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "caja",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
  await store.assets.updateAssetValuation("caja", 11_000_00);
  await store.assets.updateAssetValuation("caja", 12_000_00);

  await store.liabilities.createLiability({
    balanceMinor: 5_000_00,
    currency: "EUR",
    id: "prestamo",
    name: "Préstamo",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.updateLiabilityBalance("prestamo", 4_500_00);

  for (let i = 0; i < NOISE_HOLDINGS; i += 1) {
    const id = `ruido_${i}`;
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00 + i,
      id,
      liquidityTier: "cash",
      name: `Ruido ${i}`,
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.assets.updateAssetValuation(id, 2_000_00 + i);
  }
}

describe("windowed manual-value history (#1534)", () => {
  test("filters entity + action through the entity/created index, not a full scan", async () => {
    const client = openLibsqlClient(":memory:");
    try {
      await migrate(client);
      const plan = await queryPlan(
        client,
        "SELECT entity_id, action, details_json, created_at FROM audit_log " +
          "WHERE entity_id IN (?, ?) AND action IN (?, ?) " +
          "ORDER BY entity_id, created_at",
        "caja",
        "prestamo",
        "update_valuation",
        "update_balance",
      );
      expect(plan).toContain("USING INDEX audit_log_entity_created_idx");
      expect(plan).not.toMatch(/SCAN audit_log(?! USING INDEX)/);
    } finally {
      client.close();
    }
  });

  test("history for asked holdings matches filtering a populated log in memory", async () => {
    const store = await createInMemoryStore();
    await seedPopulatedLog(store);

    const fullLog = await store.readAuditLog();
    expect(fullLog.length).toBeGreaterThan(NOISE_HOLDINGS * 2);

    const entityIds = ["caja", "prestamo"] as const;
    const targeted = await store.agentView.readManualValueHistory(entityIds);
    const fromFullLog = historyFromFullLog(fullLog, new Set(entityIds));

    expect([...targeted.keys()].sort()).toEqual([...fromFullLog.keys()].sort());
    for (const id of entityIds) {
      expect(targeted.get(id)).toEqual(fromFullLog.get(id));
    }
    expect(targeted.has("ruido_0")).toBe(false);
    expect(targeted.get("caja")?.length).toBeGreaterThan(0);
    expect(targeted.get("prestamo")?.length).toBeGreaterThan(0);

    store.close();
  });

  test("the store SELECT filters audit_log by entity_id rather than reading every row", async () => {
    const statements: string[] = [];
    const store = await createStoreFromSqlite(
      instrumentClient(openLibsqlClient(":memory:"), (sql) => {
        statements.push(sql);
      }),
    );
    await seedPopulatedLog(store);

    statements.length = 0;
    await store.agentView.readManualValueHistory(["caja"]);
    const auditSelects = statements.filter(
      (sql) => /^\s*select\b/i.test(sql) && /\baudit_log\b/i.test(sql),
    );
    expect(auditSelects).toHaveLength(1);
    expect(auditSelects[0]).toMatch(/entity_id/i);
    expect(auditSelects[0]).toMatch(/\bin\s*\(/i);
    expect(auditSelects[0]).not.toMatch(/select \* from ["']?audit_log/i);

    store.close();
  });

  test("an empty id list does not scan audit_log", async () => {
    const statements: string[] = [];
    const real = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(
      instrumentClient(real, (sql) => {
        statements.push(sql);
      }),
    );
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });

    statements.length = 0;
    const history = await store.agentView.readManualValueHistory([]);
    expect(history.size).toBe(0);
    expect(statements.some((sql) => /\baudit_log\b/i.test(sql))).toBe(false);

    store.close();
  });
});
