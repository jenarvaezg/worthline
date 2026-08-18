/**
 * `readSnapshotHoldings({ includePositions: false })` (#1235).
 *
 * The per-position child-row read (ADR 0035, `readPositionsByHolding`) already
 * skips on a targeted single-holding read (`holdingId`, #207). This extends the
 * same skip to the unscoped/multi-holding case for a caller that only needs the
 * parent holding rows — e.g. /objetivos deriving monthly closes, which never
 * reads `positions`.
 *
 * This test pins the FIX at two levels, mirroring the #207 targeted-read suite:
 *   1. BEHAVIOR — with `includePositions: false` the parent rows are unchanged
 *      (same fields, same values) but carry no `positions` field; the default
 *      (omitted, matching every existing caller) still attaches it.
 *   2. READ COUNT — `includePositions: false` skips the extra SELECT against
 *      `snapshot_position_holdings` entirely; the default still issues it.
 */

import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

/**
 * Seed one snapshot with a connected-source holding ("coins") whose value is
 * backed by two per-position child rows (ADR 0035), reconciling to the parent.
 */
async function seedSnapshotWithPositions(client: Client): Promise<void> {
  await client.executeMultiple(`
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
      VALUES ('snap_1', 'household', 'Hogar', '2026-06-11T10:00:00.000Z',
              '2026-06-11', '2026-06', 'EUR', 500000, 500000, 0, 500000, 0);
    INSERT INTO snapshot_holdings
      (id, snapshot_id, holding_id, kind, label, value_minor)
      VALUES ('h1', 'snap_1', 'coins', 'asset', 'Monedas', 500000);
    INSERT INTO snapshot_position_holdings
      (id, snapshot_id, parent_holding_id, position_key, label, value_minor, metal, image_url)
      VALUES ('p1', 'snap_1', 'coins', 'numista_1', 'Sovereign', 300000, 'gold', NULL);
    INSERT INTO snapshot_position_holdings
      (id, snapshot_id, parent_holding_id, position_key, label, value_minor, metal, image_url)
      VALUES ('p2', 'snap_1', 'coins', 'numista_2', 'Maple', 200000, 'silver', NULL);
  `);
}

describe("readSnapshotHoldings({ includePositions }) (#1235)", () => {
  test("default (omitted) attaches the per-position child rows, matching prior behavior", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await seedSnapshotWithPositions(client);

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.positions).toEqual([
      {
        imageUrl: null,
        label: "Sovereign",
        metal: "gold",
        positionKey: "numista_1",
        valueMinor: 300000,
      },
      {
        imageUrl: null,
        label: "Maple",
        metal: "silver",
        positionKey: "numista_2",
        valueMinor: 200000,
      },
    ]);

    store.close();
  });

  test("includePositions: false omits `positions` while every other field is unchanged", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await createStoreFromSqlite(client);
    await seedSnapshotWithPositions(client);

    const withPositions = await store.snapshots.readSnapshotHoldings({
      scopeId: "household",
    });
    const withoutPositions = await store.snapshots.readSnapshotHoldings({
      includePositions: false,
      scopeId: "household",
    });

    expect(withoutPositions).toHaveLength(1);
    expect(withoutPositions[0]!.positions).toBeUndefined();
    // Every other field is byte-identical to the default read, minus `positions`.
    const { positions: _positions, ...parentFieldsWithPositions } = withPositions[0]!;
    expect(withoutPositions[0]).toEqual(parentFieldsWithPositions);

    store.close();
  });

  test("includePositions: false skips the extra SELECT against snapshot_position_holdings", async () => {
    let selects = 0;
    const tally = (text: string): void => {
      if (/^\s*select/i.test(text) && /\bsnapshot_position_holdings\b/i.test(text)) {
        selects += 1;
      }
    };
    const real = openLibsqlClient(":memory:");
    const client = instrumentClient(real, tally);
    const store = await createStoreFromSqlite(client);
    await seedSnapshotWithPositions(real);

    selects = 0;
    await store.snapshots.readSnapshotHoldings({
      includePositions: false,
      scopeId: "household",
    });
    expect(selects).toBe(0);

    selects = 0;
    await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    expect(selects).toBe(1);

    store.close();
  });
});
