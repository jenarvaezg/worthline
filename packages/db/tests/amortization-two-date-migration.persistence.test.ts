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
 *  - every frozen snapshot figure stays BYTE-IDENTICAL (the backfill reproduces
 *    the pre-#188 engine's curve, so historical figures never change), and
 *  - the re-read curve equals the known pre-#188 single-date balances to the cent.
 * A second run is a no-op (idempotent), behind the `version < 18` guard, and a
 * fresh DB (already at the two-date shape) migrates cleanly without a start_date.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import { migrate, SCHEMA_VERSION } from "../src/migrate";
import { schemaSql } from "../src/schema-sql";

/**
 * Build a genuinely pre-v18 database: rewrite the two-date columns in the runtime
 * schema back to the single `start_date` column, so migrate() exercises the real
 * legacy path (add columns + JS backfill + table rebuild), not a no-op.
 */
function seedV17(): Database.Database {
  const db = new Database(":memory:");
  const legacySql = schemaSql.replace(
    /\t`disbursement_date` text NOT NULL,\n\t`first_payment_date` text NOT NULL,\n/,
    "\t`start_date` text NOT NULL,\n",
  );
  db.exec(legacySql);
  db.pragma("user_version = 17");

  db.exec(`
    INSERT INTO liabilities (id, name, type, currency, current_balance_minor) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000_00),
      ('l_eom', 'Préstamo fin de mes', 'debt', 'EUR', 100000_00);

    INSERT INTO amortization_plans
      (id, liability_id, initial_capital_minor, annual_interest_rate, term_months, start_date)
    VALUES
      ('plan_1st', 'l_mortgage', 200000_00, '0.025', 360, '2020-01-01'),
      ('plan_eom', 'l_eom', 100000_00, '0.03', 120, '2020-01-31');

    -- A rate revision + early repayment so the table-rebuild's FK toggling is
    -- exercised against child rows that reference amortization_plans.
    INSERT INTO interest_rate_revisions
      (id, plan_id, revision_date, new_annual_interest_rate)
    VALUES ('rev1', 'plan_1st', '2023-01-01', '0.031');
    INSERT INTO early_repayments (id, plan_id, repayment_date, amount_minor, mode)
    VALUES ('erp1', 'plan_1st', '2024-01-01', 10000_00, 'reduce-payment');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2021-01-01T12:00:00.000Z', '2021-01-01', '2021-01',
       'EUR', -195465_37, -195465_37, 0, 0, 195465_37);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_mortgage', 'snap1', 'l_mortgage', 'liability', 'Hipoteca', NULL, 195465_37);
  `);

  return db;
}

const planRow = (db: Database.Database, id: string) =>
  db
    .prepare(
      "SELECT disbursement_date AS disbursement, first_payment_date AS firstPayment FROM amortization_plans WHERE id = ?",
    )
    .get(id) as { disbursement: string; firstPayment: string };

const hasStartDate = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(amortization_plans)").all() as { name: string }[]).some(
    (c) => c.name === "start_date",
  );

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("amortization two-date schema migration (v18)", () => {
  test("backfills disbursement = start_date and first_payment = start_date + 1 month", () => {
    const db = seedV17();
    migrate(db);

    expect(planRow(db, "plan_1st")).toEqual({
      disbursement: "2020-01-01",
      firstPayment: "2020-02-01",
    });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  test("clamps the first payment's day at a short month (day-31 start → Feb 29)", () => {
    const db = seedV17();
    migrate(db);

    // 2020-01-31 + 1 month clamps to 2020-02-29 (leap), exactly like the engine's
    // addMonths — never the SQLite-default 2020-03-02 overflow.
    expect(planRow(db, "plan_eom")).toEqual({
      disbursement: "2020-01-31",
      firstPayment: "2020-02-29",
    });
  });

  test("retires the start_date column (table rebuild)", () => {
    const db = seedV17();
    expect(hasStartDate(db)).toBe(true); // genuinely pre-v18
    migrate(db);
    expect(hasStartDate(db)).toBe(false);
  });

  test("preserves the plan's child rows across the table rebuild", () => {
    const db = seedV17();
    migrate(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM interest_rate_revisions").get()).toEqual(
      { n: 1 },
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM early_repayments").get()).toEqual({
      n: 1,
    });
    // Foreign keys are re-enabled and intact after the rebuild.
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  test("leaves every frozen snapshot figure byte-identical", () => {
    const db = seedV17();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const beforeSnap = db.prepare(select).get();
    const beforeHolding = db
      .prepare("SELECT value_minor FROM snapshot_holdings WHERE id = 'sh_mortgage'")
      .get();

    migrate(db);

    expect(db.prepare(select).get()).toEqual(beforeSnap);
    expect(
      db
        .prepare("SELECT value_minor FROM snapshot_holdings WHERE id = 'sh_mortgage'")
        .get(),
    ).toEqual(beforeHolding);
  });

  test("is idempotent on a second run", () => {
    const db = seedV17();
    migrate(db);

    const before = db
      .prepare(
        "SELECT id, disbursement_date, first_payment_date FROM amortization_plans ORDER BY id",
      )
      .all();
    migrate(db); // sits behind `version < 18` → no-op
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      db
        .prepare(
          "SELECT id, disbursement_date, first_payment_date FROM amortization_plans ORDER BY id",
        )
        .all(),
    ).toEqual(before);
  });

  test("a fresh database migrates to the two-date shape with no start_date", () => {
    // createInMemoryStore runs the full ladder; schema-sql already creates the
    // two-date columns, so the v18 guard must skip the rebuild cleanly.
    const store = createInMemoryStore();
    const db = new Database(":memory:");
    migrate(db);
    expect(hasStartDate(db)).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    store.close();
    db.close();
  });

  test("the migrated curve reproduces the pre-#188 single-date balance to the cent", () => {
    // Seed a pre-v18 plan, migrate, then read the curve back through the store: it
    // must equal the known pre-#188 engine output (200.000€ @ 2,5% / 360 months,
    // start 2020-01-01 → 195_465_37 on 2021-01-01, the boundary 12 figure). This
    // is the byte-identity guarantee the migration rests on.
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.liabilities.createLiability({
      balanceMinor: 200000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      id: "plan1",
      initialCapitalMinor: 200000_00,
      liabilityId: "mortgage",
      termMonths: 360,
    });

    expect(store.liabilities.debtBalanceAtDate("mortgage", "2020-01-01")).toBe(200000_00);
    expect(store.liabilities.debtBalanceAtDate("mortgage", "2021-01-01")).toBe(195465_37);
    expect(store.liabilities.debtBalanceAtDate("mortgage", "2025-01-01")).toBe(176150_76);
    store.close();
  });
});
