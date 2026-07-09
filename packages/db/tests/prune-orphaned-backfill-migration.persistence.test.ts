/**
 * Schema v29 migration (#305): one-off prune of already-orphaned fossil backfill
 * snapshots.
 *
 * A backfilled snapshot (id prefix `histsnap_`, ADR 0012) exists on a date ONLY
 * because an investment operation made it an event date. Older builds never
 * removed such a snapshot when the operation(s) justifying its date were deleted,
 * so fossils accumulated. This migration clears them: prune ONLY `histsnap_%`
 * snapshots whose YYYY-MM-DD `date_key` matches NO `asset_operations.executed_at`.
 * A real daily capture (`snapshot_…`) is never touched, even on an op-less date;
 * a backfill on a date an operation still justifies survives. Frozen holding rows
 * of pruned snapshots go too. `user_version` reaches SCHEMA_VERSION; a second run
 * is a no-op behind the `version < 29` guard.
 */

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV28(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("PRAGMA user_version = 28");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('fund', 'Fondo', 'investment', 'EUR', 0, 'market');

    -- An operation on 2024-03-01 only: that date stays justified.
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency)
    VALUES ('op_mar', 'fund', 'buy', '2024-03-01', '5', '200', 'EUR');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      -- ORPHAN: a backfill on an op-less date → must be pruned.
      ('histsnap_household_2024-01-10', 'household', 'Casa', '2024-01-10T12:00:00.000Z',
       '2024-01-10', '2024-01', 'EUR', 100000, 100000, 0, 100000, 0),
      -- JUSTIFIED: a backfill on 2024-03-01, which still has op_mar → must survive.
      ('histsnap_household_2024-03-01', 'household', 'Casa', '2024-03-01T12:00:00.000Z',
       '2024-03-01', '2024-03', 'EUR', 100000, 100000, 0, 100000, 0),
      -- DAILY CAPTURE: a real snapshot_ id on an op-less date → must survive.
      ('snapshot_household_2024_02_15_7', 'household', 'Casa', '2024-02-15T20:00:00.000Z',
       '2024-02-15', '2024-02', 'EUR', 100000, 100000, 0, 100000, 0);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_orphan', 'histsnap_household_2024-01-10', 'fund', 'asset', 'Fondo', 'market', 100000),
      ('sh_just',   'histsnap_household_2024-03-01', 'fund', 'asset', 'Fondo', 'market', 100000),
      ('sh_daily',  'snapshot_household_2024_02_15_7', 'cash', 'asset', 'Caja', 'cash', 100000);
  `);

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

describe("prune-orphaned-backfill schema migration (v29, #305)", () => {
  test("prunes the orphaned backfill snapshot and its frozen rows", async () => {
    const client = await seedV28();
    await migrate(client);

    // The op-less backfill fossil is gone...
    expect(await snapshotIds(client)).not.toContain("histsnap_household_2024-01-10");
    // ...along with its frozen holding row (cascade / explicit delete).
    expect(await holdingIds(client)).not.toContain("sh_orphan");
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("keeps a backfill snapshot whose date an operation still justifies", async () => {
    const client = await seedV28();
    await migrate(client);

    expect(await snapshotIds(client)).toContain("histsnap_household_2024-03-01");
    expect(await holdingIds(client)).toContain("sh_just");
  });

  test("never prunes a real daily-capture snapshot, even on an op-less date", async () => {
    const client = await seedV28();
    await migrate(client);

    expect(await snapshotIds(client)).toContain("snapshot_household_2024_02_15_7");
    expect(await holdingIds(client)).toContain("sh_daily");
  });

  test("is idempotent on a second run", async () => {
    const client = await seedV28();
    await migrate(client);

    const before = await snapshotIds(client);
    await migrate(client); // a second run sits behind `version < 29` → no-op
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    expect(await snapshotIds(client)).toEqual(before);
  });
});

/**
 * v29 migration regression (PR #326 review): the one-off cleanup must apply the
 * SAME widened "is this date still an event date" rule as the runtime prune —
 * NOT operation-only. A backfill on a date justified by a balance anchor, a
 * housing valuation anchor, a rate revision, an early repayment, a coin
 * acquisition, or a computed amortization cuota must SURVIVE; only a date NO such
 * fact justifies is pruned. The Binance month-end case is covered conservatively:
 * with a binance source present, every `histsnap_%` row is KEPT (the curve's
 * month-ends are live-reconstructed, never stored — when in doubt, keep).
 */
async function seedV28WithFacts(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("PRAGMA user_version = 28");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('fund', 'Fondo', 'investment', 'EUR', 0, 'market'),
      ('piso', 'Piso', 'real_estate', 'EUR', 18000000, 'illiquid'),
      ('coinsAsset', 'Numismática', 'investment', 'EUR', 0, 'illiquid');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('card', 'Tarjeta', 'debt', 'EUR', 100000, 'revolving'),
      ('mortgage', 'Hipoteca', 'mortgage', 'EUR', 15000000, 'amortizable');

    -- ONE investment op (justifies 2024-03-01 only).
    INSERT INTO asset_operations (id, asset_id, kind, executed_at, units, price_per_unit, currency)
    VALUES ('op_mar', 'fund', 'buy', '2024-03-01', '5', '200', 'EUR');

    -- Balance anchor → justifies 2025-02-01.
    INSERT INTO liability_balance_anchors (id, liability_id, balance_minor, anchor_date)
    VALUES ('an1', 'card', 300000, '2025-02-01');

    -- Housing valuation anchor → justifies 2025-03-01.
    INSERT INTO asset_valuations (id, asset_id, value_minor, valuation_date, adjusts_prior_curve)
    VALUES ('v1', 'piso', 18000000, '2025-03-01', 1);

    -- Amortization plan: disbursement 2024-01-01, first payment 2024-02-01. A
    -- COMPUTED cuota boundary lands on 2024-05-01 (= firstPayment + 3 months);
    -- there is no stored column for it → tests the JS-side boundary check.
    INSERT INTO amortization_plans
      (id, liability_id, initial_capital_minor, annual_interest_rate, term_months, disbursement_date, first_payment_date)
    VALUES ('plan1', 'mortgage', 15000000, '0.03', 240, '2024-01-01', '2024-02-01');

    -- Interest-rate revision → justifies 2025-04-01.
    INSERT INTO interest_rate_revisions (id, plan_id, revision_date, new_annual_interest_rate)
    VALUES ('rev1', 'plan1', '2025-04-01', '0.04');

    -- Early repayment → justifies 2025-05-01.
    INSERT INTO early_repayments (id, plan_id, repayment_date, amount_minor, mode)
    VALUES ('rep1', 'plan1', '2025-05-01', 1000000, 'reduce-term');

    -- A Numista coin acquisition → justifies 2025-06-01.
    INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
    VALUES ('src_coins', 'numista', 'Colección', 'coinsAsset', '{}');
    INSERT INTO positions (id, source_id, kind, name, liquidity_tier, currency, purchase_date)
    VALUES ('pos_coin', 'src_coins', 'coin', 'Moneda', 'illiquid', 'EUR', '2025-06-01');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('histsnap_household_2024-01-10', 'household', 'Casa', '2024-01-10T12:00:00.000Z',
       '2024-01-10', '2024-01', 'EUR', 100000, 100000, 0, 100000, 0),   -- ORPHAN
      ('histsnap_household_2025-02-01', 'household', 'Casa', '2025-02-01T12:00:00.000Z',
       '2025-02-01', '2025-02', 'EUR', 100000, 100000, 0, 100000, 0),   -- balance anchor
      ('histsnap_household_2025-03-01', 'household', 'Casa', '2025-03-01T12:00:00.000Z',
       '2025-03-01', '2025-03', 'EUR', 100000, 100000, 0, 100000, 0),   -- valuation anchor
      ('histsnap_household_2024-05-01', 'household', 'Casa', '2024-05-01T12:00:00.000Z',
       '2024-05-01', '2024-05', 'EUR', 100000, 100000, 0, 100000, 0),   -- amortization cuota (computed)
      ('histsnap_household_2025-04-01', 'household', 'Casa', '2025-04-01T12:00:00.000Z',
       '2025-04-01', '2025-04', 'EUR', 100000, 100000, 0, 100000, 0),   -- rate revision
      ('histsnap_household_2025-05-01', 'household', 'Casa', '2025-05-01T12:00:00.000Z',
       '2025-05-01', '2025-05', 'EUR', 100000, 100000, 0, 100000, 0),   -- early repayment
      ('histsnap_household_2025-06-01', 'household', 'Casa', '2025-06-01T12:00:00.000Z',
       '2025-06-01', '2025-06', 'EUR', 100000, 100000, 0, 100000, 0);   -- coin acquisition
  `);

  return client;
}

describe("v29 migration spares dates justified by a non-operation fact (PR #326)", () => {
  test("prunes the genuine orphan but keeps every non-operation-justified date", async () => {
    const client = await seedV28WithFacts();
    await migrate(client);

    const ids = await snapshotIds(client);
    // The op-less, fact-less date is pruned.
    expect(ids).not.toContain("histsnap_household_2024-01-10");
    // Every date justified by a non-operation dated fact survives.
    expect(ids).toContain("histsnap_household_2025-02-01"); // balance anchor
    expect(ids).toContain("histsnap_household_2025-03-01"); // valuation anchor
    expect(ids).toContain("histsnap_household_2024-05-01"); // amortization cuota (computed)
    expect(ids).toContain("histsnap_household_2025-04-01"); // rate revision
    expect(ids).toContain("histsnap_household_2025-05-01"); // early repayment
    expect(ids).toContain("histsnap_household_2025-06-01"); // coin acquisition
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("with a Binance source present, conservatively keeps every histsnap_ row", async () => {
    const client = await seedV28WithFacts();
    // Add a binance source: its month-end history dates are not stored, so the
    // migration cannot prove any histsnap_ is unjustified → keep them all.
    await client.executeMultiple(`
      INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
      VALUES ('src_binance', 'binance', 'Binance', 'fund', '{}');
    `);
    await migrate(client);

    // Even the otherwise-orphan 2024-01-10 is kept under the conservative rule.
    expect(await snapshotIds(client)).toContain("histsnap_household_2024-01-10");
  });
});
