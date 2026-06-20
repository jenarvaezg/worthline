/**
 * Schema v18 migration (#188, ADR 0019): an amortization plan's single
 * `start_date` is replaced by TWO dates — a disbursement date (firma / devengo)
 * and a first-payment date.
 *
 * A database whose `amortization_plans` predate v18 (one `start_date` column) is
 * seeded with two plans — a 1st-of-month start and a day-31 start (to exercise the
 * +1-month clamping) — plus a snapshot with frozen rows. After migrating:
 *  - disbursement_date = start_date,
 *  - first_payment_date = start_date + 1 month (day clamped to the destination
 *    month's last day, exactly like the engine's addMonths),
 *  - the start_date column is gone,
 *  - for day<=28 plans every frozen snapshot figure stays BYTE-IDENTICAL (the
 *    backfill reproduces the pre-#188 engine's boundary dates exactly, so the
 *    re-ripple is a no-op for those figures),
 *  - for day>=29 plans the re-ripple corrects frozen snapshots to the new two-date
 *    curve atomically at migration time (ADR 0019), and
 *  - the re-read curve equals the known pre-#188 single-date balances to the cent.
 * A second run is a no-op (idempotent), behind the `version < 18` guard, and a
 * fresh DB (already at the two-date shape) migrates cleanly without a start_date.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { createInMemoryStore, createStoreFromSqlite, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/**
 * Build a genuinely pre-v18 database: rewrite the two-date columns in the runtime
 * schema back to the single `start_date` column, so migrate() exercises the real
 * legacy path (add columns + JS backfill + table rebuild), not a no-op.
 */
function legacySchemaSql(): string {
  return schemaSql.replace(
    /\t`disbursement_date` text NOT NULL,\n\t`first_payment_date` text NOT NULL,\n/,
    "\t`start_date` text NOT NULL,\n",
  );
}

async function seedV17(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(legacySchemaSql());
  await client.execute("PRAGMA user_version = 17");

  await client.executeMultiple(`
    INSERT INTO liabilities (id, name, type, currency, current_balance_minor) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 20000000),
      ('l_eom', 'Préstamo fin de mes', 'debt', 'EUR', 10000000);

    INSERT INTO amortization_plans
      (id, liability_id, initial_capital_minor, annual_interest_rate, term_months, start_date)
    VALUES
      ('plan_1st', 'l_mortgage', 20000000, '0.025', 360, '2020-01-01'),
      ('plan_eom', 'l_eom', 10000000, '0.03', 120, '2020-01-31');

    -- A rate revision + early repayment so the table-rebuild's FK toggling is
    -- exercised against child rows that reference amortization_plans.
    INSERT INTO interest_rate_revisions
      (id, plan_id, revision_date, new_annual_interest_rate)
    VALUES ('rev1', 'plan_1st', '2023-01-01', '0.031');
    INSERT INTO early_repayments (id, plan_id, repayment_date, amount_minor, mode)
    VALUES ('erp1', 'plan_1st', '2024-01-01', 1000000, 'reduce-payment');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2021-01-01T12:00:00.000Z', '2021-01-01', '2021-01',
       'EUR', -19546537, -19546537, 0, 0, 19546537);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_mortgage', 'snap1', 'l_mortgage', 'liability', 'Hipoteca', NULL, 19546537);
  `);

  return client;
}

/**
 * Build a pre-v18 database WITH a workspace + ownership so the post-migrate
 * re-ripple in buildStore can fire. Contains:
 *  - day-31 plan  (l_eom / plan_eom): start=2020-01-31, 100k€, 3%, 120 months
 *    snapshot at "2021-01-31" = old boundary 12, debts_minor = 91_293_65
 *  - day-1 plan   (l_mortgage / plan_1st): start=2020-01-01, 200k€, 2.5%, 360 months
 *    snapshot at "2021-01-01" = old boundary 12, debts_minor = 195_465_37
 * Both snapshots use scope_id = 'household'.
 */
async function seedV17WithRipple(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(legacySchemaSql());
  await client.execute("PRAGMA user_version = 17");

  await client.executeMultiple(`
    INSERT INTO workspace (id, mode, base_currency) VALUES ('default', 'individual', 'EUR');
    INSERT INTO members (id, name) VALUES ('mJ', 'Jose');

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('l_mortgage', 'Hipoteca',      'mortgage', 'EUR', 20000000, 'amortizable'),
      ('l_eom',      'Préstamo EOM',  'debt',     'EUR', 10000000, 'amortizable');

    INSERT INTO liability_ownerships (liability_id, member_id, share_bps) VALUES
      ('l_mortgage', 'mJ', 10000),
      ('l_eom',      'mJ', 10000);

    INSERT INTO amortization_plans
      (id, liability_id, initial_capital_minor, annual_interest_rate, term_months, start_date)
    VALUES
      ('plan_1st', 'l_mortgage', 20000000, '0.025', 360, '2020-01-01'),
      ('plan_eom', 'l_eom',     10000000, '0.03',  120, '2020-01-31');

    -- Day-1 plan: snapshot at old boundary 12 = 2021-01-01, debts_minor = 195_465_37.
    -- After re-ripple the new curve (firstPayment=2020-02-01) has boundary 12 also
    -- at 2021-01-01 (addMonths("2020-02-01",11)="2021-01-01") → byte-identical.
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap_1st', 'household', 'Casa', '2021-01-01T12:00:00.000Z', '2021-01-01', '2021-01',
       'EUR', -19546537, -19546537, 0, 0, 19546537);
    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_1st', 'snap_1st', 'l_mortgage', 'liability', 'Hipoteca', NULL, 19546537);

    -- Day-31 plan: snapshot at old boundary 12 = 2021-01-31, debts_minor = 91_293_65.
    -- After re-ripple the new curve (firstPayment=2020-02-29) has boundary 12 at
    -- 2021-01-29 and boundary 13 at 2021-02-28. "2021-01-31" is interpolated between
    -- them → 91_244_49.
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap_eom', 'household', 'Casa', '2021-01-31T12:00:00.000Z', '2021-01-31', '2021-01',
       'EUR', -9129365, -9129365, 0, 0, 9129365);
    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_eom', 'snap_eom', 'l_eom', 'liability', 'Préstamo EOM', NULL, 9129365);
  `);

  return client;
}

const planRow = async (client: Client, id: string) =>
  (
    await client.execute({
      sql: "SELECT disbursement_date AS disbursement, first_payment_date AS firstPayment FROM amortization_plans WHERE id = ?",
      args: [id],
    })
  ).rows[0] as unknown as { disbursement: string; firstPayment: string };

const hasStartDate = async (client: Client) =>
  (
    (await client.execute("PRAGMA table_info(amortization_plans)")).rows as unknown as {
      name: string;
    }[]
  ).some((c) => c.name === "start_date");

const userVersion = async (client: Client) =>
  Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("amortization two-date schema migration (v18)", () => {
  test("backfills disbursement = start_date and first_payment = start_date + 1 month", async () => {
    const client = await seedV17();
    await migrate(client);

    expect(await planRow(client, "plan_1st")).toEqual({
      disbursement: "2020-01-01",
      firstPayment: "2020-02-01",
    });
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("clamps the first payment's day at a short month (day-31 start → Feb 29)", async () => {
    const client = await seedV17();
    await migrate(client);

    // 2020-01-31 + 1 month clamps to 2020-02-29 (leap), exactly like the engine's
    // addMonths — never the SQLite-default 2020-03-02 overflow.
    expect(await planRow(client, "plan_eom")).toEqual({
      disbursement: "2020-01-31",
      firstPayment: "2020-02-29",
    });
  });

  test("retires the start_date column (table rebuild)", async () => {
    const client = await seedV17();
    expect(await hasStartDate(client)).toBe(true); // genuinely pre-v18
    await migrate(client);
    expect(await hasStartDate(client)).toBe(false);
  });

  test("preserves the plan's child rows across the table rebuild", async () => {
    const client = await seedV17();
    await migrate(client);

    expect(
      (await client.execute("SELECT COUNT(*) AS n FROM interest_rate_revisions")).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (await client.execute("SELECT COUNT(*) AS n FROM early_repayments")).rows[0],
    ).toEqual({ n: 1 });
    // Foreign keys are re-enabled and intact after the rebuild.
    expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    expect(
      Number((await client.execute("PRAGMA foreign_keys")).rows[0]!.foreign_keys),
    ).toBe(1);
  });

  test("leaves every frozen snapshot figure byte-identical", async () => {
    const client = await seedV17();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const beforeSnap = (await client.execute(select)).rows[0];
    const beforeHolding = (
      await client.execute(
        "SELECT value_minor FROM snapshot_holdings WHERE id = 'sh_mortgage'",
      )
    ).rows[0];

    await migrate(client);

    expect((await client.execute(select)).rows[0]).toEqual(beforeSnap);
    expect(
      (
        await client.execute(
          "SELECT value_minor FROM snapshot_holdings WHERE id = 'sh_mortgage'",
        )
      ).rows[0],
    ).toEqual(beforeHolding);
  });

  test("is idempotent on a second run", async () => {
    const client = await seedV17();
    await migrate(client);

    const before = (
      await client.execute(
        "SELECT id, disbursement_date, first_payment_date FROM amortization_plans ORDER BY id",
      )
    ).rows;
    await migrate(client); // sits behind `version < 18` → no-op
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    expect(
      (
        await client.execute(
          "SELECT id, disbursement_date, first_payment_date FROM amortization_plans ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
  });

  test("a fresh database migrates to the two-date shape with no start_date", async () => {
    // createInMemoryStore runs the full ladder; schema-sql already creates the
    // two-date columns, so the v18 guard must skip the rebuild cleanly.
    const store = await createInMemoryStore();
    const client = openLibsqlClient(":memory:");
    await migrate(client);
    expect(await hasStartDate(client)).toBe(false);
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    store.close();
    client.close();
  });

  test("re-ripples day-31 plan snapshot to the new two-date curve (ADR 0019)", async () => {
    // The day-31 plan (start=2020-01-31) gets firstPayment=2020-02-29 after backfill.
    // addMonths(addMonths("2020-01-31",1), m-1) ≠ addMonths("2020-01-31", m) for m≥2,
    // so the new curve diverges from the old single-date curve at most boundary dates.
    // The pre-migration snapshot at "2021-01-31" (= old boundary 12) had l_eom = 91_293_65.
    // After re-ripple the holding row for l_eom must reflect the new curve: 91_244_49.
    const client = await seedV17WithRipple();
    const store = await createStoreFromSqlite(client); // migrate + re-ripple fires here
    try {
      // Check the frozen holding row for l_eom at 2021-01-31 (not the snapshot aggregate,
      // which also includes l_mortgage added by its own re-ripple on the same date range).
      const holdings = await store.snapshots.readSnapshotHoldings({
        from: "2021-01-31",
        scopeId: "household",
        to: "2021-01-31",
      });
      const eomRow = holdings.find(
        (h) => h.holdingId === "l_eom" && h.kind === "liability",
      );
      expect(eomRow).toBeDefined();
      expect(eomRow!.valueMinor).toBe(91_244_49);
    } finally {
      store.close();
    }
  });

  test("day-1 plan snapshot holding stays byte-identical after re-ripple (no-op case)", async () => {
    // The day-1 plan (start=2020-01-01) gets firstPayment=2020-02-01 after backfill.
    // addMonths("2020-02-01", m-1) = addMonths("2020-01-01", m) for all m (the
    // composition trap only bites when day>=29). So the new curve boundary dates are
    // identical to the old single-date curve boundary dates, and the re-ripple is a
    // no-op for figures: the l_mortgage holding at its boundary date is unchanged.
    const client = await seedV17WithRipple();
    const store = await createStoreFromSqlite(client); // migrate + re-ripple fires here
    try {
      const holdings = await store.snapshots.readSnapshotHoldings({
        from: "2021-01-01",
        scopeId: "household",
        to: "2021-01-01",
      });
      const mortgageRow = holdings.find(
        (h) => h.holdingId === "l_mortgage" && h.kind === "liability",
      );
      expect(mortgageRow).toBeDefined();
      expect(mortgageRow!.valueMinor).toBe(195_465_37); // unchanged
    } finally {
      store.close();
    }
  });

  test("the migrated curve reproduces the pre-#188 single-date balance to the cent", async () => {
    // Seed a pre-v18 plan, migrate, then read the curve back through the store: it
    // must equal the known pre-#188 engine output (200.000€ @ 2,5% / 360 months,
    // start 2020-01-01 → 195_465_37 on 2021-01-01, the boundary 12 figure). This
    // is the byte-identity guarantee the migration rests on.
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 200000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      id: "plan1",
      initialCapitalMinor: 200000_00,
      liabilityId: "mortgage",
      termMonths: 360,
    });

    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2020-01-01")).toBe(
      200000_00,
    );
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2021-01-01")).toBe(
      195465_37,
    );
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2025-01-01")).toBe(
      176150_76,
    );
    store.close();
  });
});
