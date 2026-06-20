/**
 * Schema v30 migration (#306): one-off cleanup of already-orphaned scope
 * snapshots.
 *
 * A snapshot must exist only for a scope `listScopeOptions` currently offers
 * (ADR 0008 frozen history is per scope). Older builds dropped a scope — a mode
 * switch to individual, a disabled/removed member, a deleted group — without
 * removing that scope's snapshots, so orphaned-scope fossils accumulated. This
 * migration clears them, reproducing the runtime rule in SQL against the stored
 * workspace:
 *   - the `household` scope ALWAYS survives;
 *   - in `individual` mode only `household` is offered → every other scope is
 *     purged;
 *   - in `household` mode the active members (`disabled_at IS NULL`) and the
 *     groups are offered → snapshots on any other scope are purged.
 * Frozen holding rows of pruned snapshots go too; `user_version` reaches
 * SCHEMA_VERSION; a second run is a no-op behind the `version < 30` guard.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

function seedSnapshot(scopeId: string, suffix: string): string {
  return `
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap_${suffix}', '${scopeId}', '${scopeId}', '2024-01-10T12:00:00.000Z',
       '2024-01-10', '2024-01', 'EUR', 100000, 100000, 0, 100000, 0);
    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor)
      VALUES ('sh_${suffix}', 'snap_${suffix}', 'cash', 'asset', 'Caja', 'cash', 100000);
  `;
}

/** Household workspace: Jose active, Ana disabled, one group. */
async function seedHouseholdV29(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("PRAGMA user_version = 29");

  await client.executeMultiple(`
    INSERT INTO workspace (id, mode, base_currency) VALUES ('default', 'household', 'EUR');
    INSERT INTO members (id, name, disabled_at) VALUES
      ('mJ', 'Jose', NULL),
      ('mA', 'Ana', '2024-05-01T00:00:00.000Z');
    INSERT INTO member_groups (id, name) VALUES ('gP', 'Pareja');
  `);
  await client.executeMultiple(seedSnapshot("household", "household")); // survives (always)
  await client.executeMultiple(seedSnapshot("mJ", "mJ")); // survives (active member)
  await client.executeMultiple(seedSnapshot("gP", "gP")); // survives (group)
  await client.executeMultiple(seedSnapshot("mA", "mA")); // ORPHAN: member disabled → not offered
  await client.executeMultiple(seedSnapshot("gGone", "gGone")); // ORPHAN: group no longer exists

  return client;
}

/** Individual workspace: only the household scope is ever offered. */
async function seedIndividualV29(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("PRAGMA user_version = 29");

  await client.executeMultiple(`
    INSERT INTO workspace (id, mode, base_currency) VALUES ('default', 'individual', 'EUR');
    INSERT INTO members (id, name, disabled_at) VALUES ('mJ', 'Jose', NULL);
  `);
  await client.executeMultiple(seedSnapshot("household", "household")); // survives (always)
  await client.executeMultiple(seedSnapshot("mJ", "mJ")); // ORPHAN: individual mode offers only household
  await client.executeMultiple(seedSnapshot("gP", "gP")); // ORPHAN

  return client;
}

const snapshotIds = async (client: Client): Promise<string[]> =>
  (
    (await client.execute("SELECT id FROM snapshots ORDER BY id")).rows as unknown as {
      id: string;
    }[]
  ).map((r) => r.id);

const holdingIds = async (client: Client): Promise<string[]> =>
  (
    (await client.execute("SELECT id FROM snapshot_holdings ORDER BY id"))
      .rows as unknown as {
      id: string;
    }[]
  ).map((r) => r.id);

const userVersion = async (client: Client): Promise<number> =>
  Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);

describe("purge-orphaned-scope schema migration (v30, #306)", () => {
  test("household: prunes disabled-member and deleted-group scopes, keeps household / active member / group", async () => {
    const client = await seedHouseholdV29();
    await migrate(client);

    expect(await snapshotIds(client)).toEqual(["snap_gP", "snap_household", "snap_mJ"]);
    expect(await holdingIds(client)).toEqual(["sh_gP", "sh_household", "sh_mJ"]);
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("individual: prunes every scope but household", async () => {
    const client = await seedIndividualV29();
    await migrate(client);

    expect(await snapshotIds(client)).toEqual(["snap_household"]);
    expect(await holdingIds(client)).toEqual(["sh_household"]);
  });

  test("never prunes the household scope", async () => {
    const householdClient = await seedHouseholdV29();
    await migrate(householdClient);
    expect(await snapshotIds(householdClient)).toContain("snap_household");

    const individualClient = await seedIndividualV29();
    await migrate(individualClient);
    expect(await snapshotIds(individualClient)).toContain("snap_household");
  });

  test("is idempotent on a second run", async () => {
    const client = await seedHouseholdV29();
    await migrate(client);

    const before = await snapshotIds(client);
    await migrate(client); // second run sits behind `version < 30` → no-op
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    expect(await snapshotIds(client)).toEqual(before);
  });
});
