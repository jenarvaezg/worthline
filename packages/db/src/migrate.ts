import type { Client } from "@libsql/client";

import { schemaSql } from "./schema-sql";

export const SCHEMA_VERSION = 32;

/** Last calendar day of the given year/month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The YYYY-MM-DD `count` whole months after `dateKey`, day clamped to the
 * destination month's last valid day — the SAME `addMonths` rule the amortization
 * engine (`amortizationPaymentDatesUpTo`) uses. Duplicated here (not imported)
 * because migrate.ts is a leaf with no `@worthline/domain` dependency; the v29
 * prune recomputes a plan's payment boundaries to spare backfill snapshots on a
 * computed cuota date (#326 review), mirroring the engine to the day.
 */
function addMonthsClamped(dateKey: string, count: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const zeroBased = month - 1 + count;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(newYear, newMonth));
  const mm = String(newMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${newYear}-${mm}-${dd}`;
}

/**
 * Every amortization payment-boundary date of a plan — boundary 0 is the
 * disbursement, boundary m≥1 is `firstPaymentDate + (m−1) months` — exactly the
 * set `amortizationPaymentDatesUpTo` generates (ADR 0019). Used by the v29 prune
 * to spare a backfill snapshot on a COMPUTED cuota date (no stored column).
 */
function amortizationBoundaryDates(plan: {
  disbursement_date: string;
  first_payment_date: string;
  term_months: number;
}): string[] {
  const dates: string[] = [];
  for (let m = 0; m <= plan.term_months; m += 1) {
    dates.push(
      m === 0 ? plan.disbursement_date : addMonthsClamped(plan.first_payment_date, m - 1),
    );
  }
  return dates;
}

export interface MigrateResult {
  /** True when the v18 backfill ran — the two-date model was just applied to
   *  existing rows, so the caller must re-ripple every amortizable debt to
   *  rewrite historical snapshots from the new curve (ADR 0019). */
  ranV18Backfill: boolean;
}

/**
 * Run any DDL/DML statement, tolerating ONLY a missing target table.
 *
 * The v23/v24 index migrations and the v26 backfill UPDATE run over tables that
 * every real v<N DB carries (created at v<2 by schema-sql), but a minimal
 * synthetic upgrade fixture may stand up only a subset — so a statement over an
 * absent table must be a no-op rather than aborting the ladder. A bare `catch {}`
 * would ALSO swallow a genuine DDL/DML bug (a column typo, malformed SQL) while
 * still bumping `user_version`; this narrows the tolerance to "no such table" and
 * rethrows everything else so a real migration error surfaces instead of failing
 * silent.
 */
export async function execToleratingMissingTable(
  client: Client,
  sql: string,
): Promise<void> {
  try {
    await client.executeMultiple(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return;
    throw err;
  }
}

export async function migrate(client: Client): Promise<MigrateResult> {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");

  const version = Number(
    (await client.execute("PRAGMA user_version")).rows[0]!.user_version,
  );
  if (version >= SCHEMA_VERSION) return { ranV18Backfill: false };

  // Set by the v18 block and returned at the end — must survive later migration
  // steps (v19+) rather than short-circuiting the ladder with an early return.
  let ranV18Backfill = false;

  if (version < 2) {
    const safeSql = schemaSql
      .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
      .replaceAll("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ");
    await client.executeMultiple(safeSql);
    await client.execute("PRAGMA user_version = 2");
  }

  if (version < 3) {
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS asset_price_cache (
      asset_id TEXT PRIMARY KEY NOT NULL, currency TEXT NOT NULL, price TEXT NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL, price_date TEXT, fetched_at TEXT NOT NULL,
      freshness_state TEXT DEFAULT 'manual' NOT NULL, stale_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.execute("PRAGMA user_version = 3");
  }

  if (version < 4) {
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );`);
    try {
      await client.executeMultiple("ALTER TABLE assets ADD COLUMN deleted_at TEXT");
    } catch {}
    try {
      await client.executeMultiple("ALTER TABLE liabilities ADD COLUMN deleted_at TEXT");
    } catch {}
    await client.execute("PRAGMA user_version = 4");
  }

  if (version < 5) {
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS warning_overrides (
      code TEXT NOT NULL, entity_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (code, entity_id)
    );`);
    await client.execute("PRAGMA user_version = 5");
  }

  if (version < 6) {
    // ADR 0005: monthly closes are now derived (last snapshot of each calendar
    // month), not declared via the is_monthly_close flag. The column is kept for
    // backward compatibility but derivation wins over any persisted flag.
    // No structural change needed — bump version to mark the semantic transition.
    await client.execute("PRAGMA user_version = 6");
  }

  if (version < 7) {
    // ADR 0008: snapshots capture the valued portfolio holding by holding.
    // Label and tier are denormalized on purpose (frozen history) — the only
    // foreign key points at the owning snapshot row, never into holdings.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS snapshot_holdings (
      id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      liquidity_tier TEXT,
      value_minor INTEGER NOT NULL,
      units TEXT,
      unit_price TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS snapshot_holdings_snapshot_kind_holding_unique
       ON snapshot_holdings (snapshot_id, kind, holding_id);`,
    );
    await client.execute("PRAGMA user_version = 7");
  }

  if (version < 8) {
    try {
      await client.executeMultiple(
        "ALTER TABLE investment_assets ADD COLUMN price_provider TEXT",
      );
    } catch {}
    await client.execute("PRAGMA user_version = 8");
  }

  if (version < 9) {
    // PRD #108 slice 4: housing valuation anchors + an appreciation rate on the
    // owning asset. The anchor→real_estate invariant is a domain/caller guard,
    // not a SQL constraint (R9).
    try {
      await client.executeMultiple(
        "ALTER TABLE assets ADD COLUMN annual_appreciation_rate TEXT",
      );
    } catch {}
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS asset_valuations (
      id TEXT PRIMARY KEY NOT NULL,
      asset_id TEXT NOT NULL,
      value_minor INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      adjusts_prior_curve INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS asset_valuations_asset_date_unique
       ON asset_valuations (asset_id, valuation_date);`,
    );
    await client.execute("PRAGMA user_version = 9");
  }

  if (version < 10) {
    // PRD #109 slice 7: French-amortization plans + interest-rate revisions, and
    // a debt_model on the owning liability. The plan→amortizable invariant is a
    // domain/caller guard, not a SQL constraint (R9).
    try {
      await client.executeMultiple("ALTER TABLE liabilities ADD COLUMN debt_model TEXT");
    } catch {}
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS amortization_plans (
      id TEXT PRIMARY KEY NOT NULL,
      liability_id TEXT NOT NULL,
      initial_capital_minor INTEGER NOT NULL,
      annual_interest_rate TEXT NOT NULL,
      term_months INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS amortization_plans_liability_unique
       ON amortization_plans (liability_id);`,
    );
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS interest_rate_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      revision_date TEXT NOT NULL,
      new_annual_interest_rate TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES amortization_plans(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS interest_rate_revisions_plan_date_unique
       ON interest_rate_revisions (plan_id, revision_date);`,
    );
    await client.execute("PRAGMA user_version = 10");
  }

  if (version < 11) {
    // PRD #109 slice 8: balance anchors for revolving/informal liabilities. The
    // anchor→{revolving,informal} invariant is a domain/caller guard, not a SQL
    // constraint (R9). balance_minor is the TOTAL owed (interest included if any).
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS liability_balance_anchors (
      id TEXT PRIMARY KEY NOT NULL,
      liability_id TEXT NOT NULL,
      balance_minor INTEGER NOT NULL,
      anchor_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS liability_balance_anchors_liability_date_unique
       ON liability_balance_anchors (liability_id, anchor_date);`,
    );
    await client.execute("PRAGMA user_version = 11");
  }

  if (version < 12) {
    // ADR 0013: recut the liquidity ladder to four pure-accessibility rungs.
    // `retirement → term-locked` and `housing → illiquid`, applied to live
    // holdings and to the denormalized frozen tier on snapshot-holding rows
    // (ADR 0008). The snapshots' frozen FIGURES are never touched, so historical
    // net worth, liquid net worth and housing equity stay byte-identical.
    await client.executeMultiple(
      "UPDATE assets SET liquidity_tier = 'term-locked' WHERE liquidity_tier = 'retirement';",
    );
    await client.executeMultiple(
      "UPDATE assets SET liquidity_tier = 'illiquid' WHERE liquidity_tier = 'housing';",
    );
    await client.executeMultiple(
      "UPDATE snapshot_holdings SET liquidity_tier = 'term-locked' WHERE liquidity_tier = 'retirement';",
    );
    await client.executeMultiple(
      "UPDATE snapshot_holdings SET liquidity_tier = 'illiquid' WHERE liquidity_tier = 'housing';",
    );
    await client.execute("PRAGMA user_version = 12");
  }

  if (version < 13) {
    // ADR 0014 (#148): valuation method becomes a first-class column, backfilled
    // from each holding's current type / debt model — investment → derived, a
    // real-estate OR primary-residence asset → appreciating, else stored;
    // amortizable → amortized, revolving/informal → anchored, no model → stored.
    // The asset precedence mirrors the runtime boundary (assetValuationInput is
    // investment-first, then isHousingAsset) so the persisted column never
    // disagrees with the derived method. Nullable, no CHECK (the enum is enforced
    // in TS, like liquidity_tier). The dispatcher still derives the method at the
    // valuation boundary in S2, so this column changes no figure; it is the schema
    // seam later slices build on.
    try {
      await client.executeMultiple("ALTER TABLE assets ADD COLUMN valuation_method TEXT");
    } catch {}
    try {
      await client.executeMultiple(
        "ALTER TABLE liabilities ADD COLUMN valuation_method TEXT",
      );
    } catch {}
    await client.executeMultiple(
      `UPDATE assets SET valuation_method = CASE
         WHEN type = 'investment' THEN 'derived'
         WHEN type = 'real_estate' OR is_primary_residence = 1 THEN 'appreciating'
         ELSE 'stored' END;`,
    );
    await client.executeMultiple(
      `UPDATE liabilities SET valuation_method = CASE debt_model
         WHEN 'amortizable' THEN 'amortized'
         WHEN 'revolving' THEN 'anchored'
         WHEN 'informal' THEN 'anchored'
         ELSE 'stored' END;`,
    );
    await client.execute("PRAGMA user_version = 13");
  }

  if (version < 14) {
    // ADR 0014 (#149): instrument — what a holding IS — becomes a first-class
    // column, backfilled from each holding's current type / debt model. Assets:
    // a real-estate OR primary-residence asset → property (mirroring the runtime
    // isHousingAsset boundary, so housing equity stays byte-identical when it is
    // re-sourced from instrument = 'property'); cash → current_account; an
    // investment → pension_plan when priced by Finect, else fund (the coarse
    // default — new investments resolve finer via the symbol-search quote type);
    // everything else → other. Liabilities: a mortgage → mortgage, a revolving
    // debt → credit_card, every other debt → loan. Nullable, no CHECK (the enum
    // is enforced in TS, like valuation_method). The instrument is forward-prep
    // for valuation in this slice — only housing reads it — so it changes no
    // figure; it is the schema seam later slices build the add flow on.
    try {
      await client.executeMultiple("ALTER TABLE assets ADD COLUMN instrument TEXT");
    } catch {}
    try {
      await client.executeMultiple("ALTER TABLE liabilities ADD COLUMN instrument TEXT");
    } catch {}
    await client.executeMultiple(
      `UPDATE assets SET instrument = CASE
         WHEN type = 'real_estate' OR is_primary_residence = 1 THEN 'property'
         WHEN type = 'cash' THEN 'current_account'
         WHEN type = 'investment' THEN COALESCE(
           (SELECT CASE WHEN ia.price_provider = 'finect' THEN 'pension_plan' ELSE 'fund' END
            FROM investment_assets ia WHERE ia.asset_id = assets.id),
           'fund')
         ELSE 'other' END;`,
    );
    await client.executeMultiple(
      `UPDATE liabilities SET instrument = CASE
         WHEN type = 'mortgage' THEN 'mortgage'
         WHEN debt_model = 'revolving' THEN 'credit_card'
         ELSE 'loan' END;`,
    );
    await client.execute("PRAGMA user_version = 14");
  }

  if (version < 15) {
    // PRD #146 slice S4: lump-sum early repayments (amortización anticipada) on
    // an amortization plan. The repayment→amortizable invariant is a
    // domain/caller guard, not a SQL constraint (R9). The unique index keeps one
    // repayment per plan per date; `mode` ∈ {reduce-payment, reduce-term} is
    // enforced in TS, like the other text enums (no CHECK).
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS early_repayments (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      repayment_date TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES amortization_plans(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS early_repayments_plan_date_unique
       ON early_repayments (plan_id, repayment_date);`,
    );
    await client.execute("PRAGMA user_version = 15");
  }

  if (version < 16) {
    // #180 (ADR 0008): freeze each snapshot-holding row's housing-securing signal
    // so historical figures never re-derive it from live holding identity (a live
    // foreign key into frozen history, which ADR 0008 forbids). secures_housing is
    // backfilled to 1 for any frozen LIABILITY row whose live liability is
    // associated to a current housing asset — the same pragmatic "current
    // classification" basis the liquidity_tier denormalization (v12) used. Housing
    // mirrors the runtime isHousingAsset boundary: instrument = 'property', or
    // (for assets predating the instrument backfill) type = 'real_estate' OR
    // is_primary_residence = 1. Assets and unassociated debts stay 0. This touches
    // no snapshot FIGURE — it is an additive, self-classifying signal.
    try {
      await client.executeMultiple(
        "ALTER TABLE snapshot_holdings ADD COLUMN secures_housing INTEGER NOT NULL DEFAULT 0",
      );
    } catch {}
    await client.executeMultiple(
      `UPDATE snapshot_holdings SET secures_housing = 1
       WHERE kind = 'liability'
         AND holding_id IN (
           SELECT l.id FROM liabilities l
           JOIN assets a ON a.id = l.associated_asset_id
           WHERE a.instrument = 'property'
              OR a.type = 'real_estate'
              OR a.is_primary_residence = 1
         );`,
    );
    await client.execute("PRAGMA user_version = 16");
  }

  if (version < 17) {
    // #181 (ADR 0008): freeze each snapshot-holding ASSET row's housing-membership
    // signal so the housing-equity axis is fully row-derivable from frozen flags —
    // no live `isHousingAsset` call needed in ripples. counts_as_housing mirrors
    // isHousingAsset at backfill time: instrument = 'property', or (for assets
    // predating the instrument backfill) type = 'real_estate' OR
    // is_primary_residence = 1. Liabilities and non-housing assets stay 0.
    // This is the asset-side complement of the v16 `secures_housing` migration.
    try {
      await client.executeMultiple(
        "ALTER TABLE snapshot_holdings ADD COLUMN counts_as_housing INTEGER NOT NULL DEFAULT 0",
      );
    } catch {}
    await client.executeMultiple(
      `UPDATE snapshot_holdings SET counts_as_housing = 1
       WHERE kind = 'asset'
         AND holding_id IN (
           SELECT a.id FROM assets a
           WHERE a.instrument = 'property'
              OR a.type = 'real_estate'
              OR a.is_primary_residence = 1
         );`,
    );
    await client.execute("PRAGMA user_version = 17");
  }

  if (version < 18) {
    // ADR 0019 (#188): an amortization plan carries TWO dates — a disbursement
    // date (firma / devengo: the debt appears at its initial capital) and a
    // first-payment date (the first cuota; the balance amortizes from here on its
    // day-of-month, term counted from here) — replacing the single `start_date`.
    //
    // Forward migration (ADR 0002): backfill disbursement_date = start_date and
    // first_payment_date = start_date + 1 month (day clamped to the destination
    // month's last day, exactly as the engine's addMonths). That reproduces the
    // pre-#188 engine's "first payment one month after start" rule, so the curve
    // is byte-identical on every payment-boundary date addMonths(start, m) — which
    // is precisely the set of dates historical snapshots are taken on. No existing
    // snapshot figure changes, so — like the figure-preserving v12/v16/v17
    // migrations — this needs no re-ripple to refresh derived history; the
    // amortizable curve is unchanged at every snapshot date.
    //
    // SQLite cannot ALTER ADD a NOT NULL column nor compute the clamped +1 month
    // in pure SQL, so we add the columns nullable, backfill in JS with the engine's
    // clamping rule, then table-rebuild to the final shape (two NOT NULL dates, no
    // start_date). Guarded by start_date's presence so a fresh DB — already created
    // at the two-date shape from schema-sql — skips the rebuild (idempotent).
    const columns = (await client.execute("PRAGMA table_info(amortization_plans)"))
      .rows as unknown as { name: string }[];
    const hasStartDate = columns.some((c) => c.name === "start_date");

    if (hasStartDate) {
      ranV18Backfill = true;
      await client.executeMultiple(
        "ALTER TABLE amortization_plans ADD COLUMN disbursement_date TEXT",
      );
      await client.executeMultiple(
        "ALTER TABLE amortization_plans ADD COLUMN first_payment_date TEXT",
      );

      const plans = (
        await client.execute("SELECT id, start_date FROM amortization_plans")
      ).rows as unknown as { id: string; start_date: string }[];
      for (const plan of plans) {
        // first_payment_date = start_date + 1 month, day-clamped — the engine's
        // "first payment one month after start" rule to the day (ADR 0019), so
        // existing snapshots stay byte-identical.
        await client.execute({
          sql: "UPDATE amortization_plans SET disbursement_date = ?, first_payment_date = ? WHERE id = ?",
          args: [plan.start_date, addMonthsClamped(plan.start_date, 1), plan.id],
        });
      }

      // Table-rebuild to drop start_date and enforce NOT NULL on the two dates,
      // preserving the FK and the 1:1 unique index (the SQLite-recommended
      // table rebuild). Foreign keys are toggled OFF for the rebuild: the child
      // tables (interest_rate_revisions, early_repayments) reference
      // amortization_plans by NAME, so after the drop + rename their FKs resolve
      // to the rebuilt table unchanged — but the transient DROP would otherwise
      // trip the enforcement. The rebuild steps (CREATE new, INSERT, DROP old,
      // RENAME) are wrapped in an explicit transaction so a crash between DROP
      // and RENAME cannot leave the DB without an amortization_plans table.
      // PRAGMA foreign_keys must be toggled outside any transaction (SQLite docs).
      await client.execute("PRAGMA foreign_keys = OFF");
      await client.executeMultiple(`BEGIN;
        CREATE TABLE amortization_plans_new (
          id TEXT PRIMARY KEY NOT NULL,
          liability_id TEXT NOT NULL,
          initial_capital_minor INTEGER NOT NULL,
          annual_interest_rate TEXT NOT NULL,
          term_months INTEGER NOT NULL,
          disbursement_date TEXT NOT NULL,
          first_payment_date TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
          FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON UPDATE no action ON DELETE cascade
        );
        INSERT INTO amortization_plans_new
          (id, liability_id, initial_capital_minor, annual_interest_rate, term_months,
           disbursement_date, first_payment_date, created_at)
          SELECT id, liability_id, initial_capital_minor, annual_interest_rate, term_months,
                 disbursement_date, first_payment_date, created_at
          FROM amortization_plans;
        DROP TABLE amortization_plans;
        ALTER TABLE amortization_plans_new RENAME TO amortization_plans;
        CREATE UNIQUE INDEX IF NOT EXISTS amortization_plans_liability_unique
          ON amortization_plans (liability_id);
        COMMIT;`);
      await client.execute("PRAGMA foreign_keys = ON");
    }
    await client.execute("PRAGMA user_version = 18");
  }

  if (version < 19) {
    // PRD #160 / #163 (ADR 0016/0017): connected sources mirror an external
    // account read-only and project their positions into one rolled-up holding.
    // credentials_json + token_json are LOCAL ONLY — never exported (ADR 0016).
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS connected_sources (
      id TEXT PRIMARY KEY NOT NULL,
      adapter TEXT NOT NULL,
      label TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      credentials_json TEXT NOT NULL,
      token_json TEXT,
      last_sync_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      catalogue_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      liquidity_tier TEXT NOT NULL,
      metal TEXT,
      purchase_date TEXT,
      purchase_price_minor INTEGER,
      metal_value_minor INTEGER,
      numismatic_value_minor INTEGER,
      currency TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (source_id) REFERENCES connected_sources(id) ON UPDATE no action ON DELETE cascade
    );`);
    await client.execute("PRAGMA user_version = 19");
  }

  if (version < 20) {
    // PRD #160 / #166 (ADR 0017): decouple coin valuation from position sync.
    // The valuation refresh recomputes a coin's melt value from its stored detail
    // × the daily metal spot, and refetches Numista's per-grade estimate only past
    // a long TTL — so positions carry the issue id, the indefinite detail
    // (fineness + weight), and when the estimate was last fetched. Forward-only
    // ALTERs (ADR 0002); existing rows get NULLs and are repopulated on next sync.
    // Wrapped in try/catch like the other column adds: on a fresh DB the columns
    // already exist (created by schema-sql at v<2), so the duplicate is ignored.
    try {
      await client.executeMultiple("ALTER TABLE positions ADD COLUMN issue_id INTEGER");
    } catch {}
    try {
      await client.executeMultiple(
        "ALTER TABLE positions ADD COLUMN fineness_millis INTEGER",
      );
    } catch {}
    try {
      await client.executeMultiple("ALTER TABLE positions ADD COLUMN weight_grams REAL");
    } catch {}
    try {
      await client.executeMultiple(
        "ALTER TABLE positions ADD COLUMN numismatic_fetched_at TEXT",
      );
    } catch {}
    await client.execute("PRAGMA user_version = 20");
  }

  if (version < 21) {
    // ADR 0017 (#167): persist Numista's stable collected-item id on each
    // position so a wholesale re-sync can tell a genuinely new trade (ripple it
    // into history) from a coin already frozen in past snapshots. Nullable for
    // the rows that predate it; every sync from now on sets it.
    try {
      await client.executeMultiple("ALTER TABLE positions ADD COLUMN external_id TEXT");
    } catch {}
    await client.execute("PRAGMA user_version = 21");
  }

  if (version < 22) {
    // #215: persist the coin's mint year on each position so the catalogue row
    // shows the coin's year (not its acquisition date). Forward-only, nullable —
    // existing rows get NULL and are repopulated on the next sync.
    try {
      await client.executeMultiple("ALTER TABLE positions ADD COLUMN year INTEGER");
    } catch {}
    await client.execute("PRAGMA user_version = 22");
  }

  if (version < 23) {
    // #201: index the hot filtered reads the performance audit (#200) flagged so
    // they resolve through a lookup plan instead of a full table scan as a
    // workspace grows. These are purely structural — they change HOW the existing
    // reads are planned, never WHAT they return, so no figure moves:
    //  - asset_operations (asset_id, executed_at, id): readOperations filters by
    //    asset and orders by execution date/id — the composite matches both, so
    //    the per-investment read is an indexed range scan with no temp-b-tree sort.
    //  - audit_log (entity_id, created_at): readAuditLog by entity filters by
    //    entity and orders by creation time — same shape, same win.
    //  - assets / liabilities (name) WHERE deleted_at IS NOT NULL: the trash reads
    //    scan only the (tiny) set of trashed rows, ordered by name, instead of the
    //    whole holdings table. PARTIAL indexes keep them small as live holdings grow.
    // IF NOT EXISTS because a fresh DB already created these via schema-sql at v<2.
    // Each statement tolerates only a missing target table (synthetic upgrade
    // fixtures may stand up a subset); a real DDL error still surfaces — see
    // execToleratingMissingTable.
    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS asset_operations_asset_executed_idx ON asset_operations (asset_id, executed_at, id);",
    );
    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS audit_log_entity_created_idx ON audit_log (entity_id, created_at);",
    );
    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS assets_deleted_at_idx ON assets (name) WHERE deleted_at IS NOT NULL;",
    );
    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS liabilities_deleted_at_idx ON liabilities (name) WHERE deleted_at IS NOT NULL;",
    );
    await client.execute("PRAGMA user_version = 23");
  }

  if (version < 24) {
    // #207: index snapshot_holdings by (holding_id, kind) so the housing
    // valuation/appreciation ripples can find a single asset's earliest frozen
    // snapshot through a lookup instead of scanning every frozen row into memory.
    // Purely structural — it changes HOW the targeted read is planned, never WHAT
    // any snapshot or figure holds (ADR 0008 frozen rows are untouched).
    // The pre-existing unique index leads with snapshot_id, so it cannot serve a
    // holding-first lookup; this composite does, with kind as the second key.
    // IF NOT EXISTS / missing-table-tolerant like the v23 indexes: a fresh DB
    // already created it via schema-sql, and a minimal synthetic upgrade fixture
    // may lack the table — but a real DDL error still surfaces.
    await execToleratingMissingTable(
      client,
      "CREATE INDEX IF NOT EXISTS snapshot_holdings_holding_kind_idx ON snapshot_holdings (holding_id, kind);",
    );
    await client.execute("PRAGMA user_version = 24");
  }

  if (version < 25) {
    // ADR 0021 (#246): generalize `positions` to carry a second adapter's shape —
    // a Binance token balance — beside the Numista coin. A discriminant `kind`
    // ('coin' | 'token') tags each row; the coin columns become NULLABLE (a token
    // has none) and four token columns are added (symbol, balance, wallet,
    // unit_price). SQLite cannot drop a NOT NULL constraint in place, so the table
    // is REBUILT.
    //
    // This is a DEFENSIVE rebuild (per the positions-table drift lesson, memory):
    // the target shape is created fresh and only the columns the OLD table ACTUALLY
    // has are copied across — so an intermediate build that left `positions` in a
    // half-migrated shape (e.g. missing metal_value_minor) still converges instead
    // of throwing "no such column". Every existing row is a coin, so `kind`
    // defaults to 'coin'. Guarded by the absence of `kind` so a fresh DB — already
    // created at the new shape by schema-sql — skips the rebuild (idempotent).
    //
    // FKs are toggled OFF for the rebuild (SQLite docs: PRAGMA outside any
    // transaction); the steps are wrapped in one transaction so a crash between
    // DROP and RENAME cannot leave the DB without a `positions` table. No other
    // table references `positions`, and its own FK to connected_sources resolves
    // by name after the rename.
    const positionCols = (
      (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
        name: string;
      }[]
    ).map((c) => c.name);

    if (positionCols.length > 0 && !positionCols.includes("kind")) {
      // The columns shared by the old and new shapes — copied verbatim; any the old
      // (possibly drifted) table lacks are simply skipped and default/NULL in the new.
      const carry = [
        "id",
        "source_id",
        "external_id",
        "catalogue_id",
        "issue_id",
        "name",
        "grade",
        "quantity",
        "year",
        "liquidity_tier",
        "metal",
        "fineness_millis",
        "weight_grams",
        "purchase_date",
        "purchase_price_minor",
        "metal_value_minor",
        "numismatic_value_minor",
        "numismatic_fetched_at",
        "currency",
        "created_at",
      ].filter((c) => positionCols.includes(c));
      const carryList = carry.join(", ");

      await client.execute("PRAGMA foreign_keys = OFF");
      await client.executeMultiple(`BEGIN;
        CREATE TABLE positions_new (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT DEFAULT 'coin' NOT NULL,
          external_id TEXT,
          name TEXT NOT NULL,
          liquidity_tier TEXT NOT NULL,
          currency TEXT NOT NULL,
          catalogue_id TEXT,
          issue_id INTEGER,
          grade TEXT,
          quantity INTEGER,
          year INTEGER,
          metal TEXT,
          fineness_millis INTEGER,
          weight_grams REAL,
          purchase_date TEXT,
          purchase_price_minor INTEGER,
          metal_value_minor INTEGER,
          numismatic_value_minor INTEGER,
          numismatic_fetched_at TEXT,
          symbol TEXT,
          balance TEXT,
          wallet TEXT,
          unit_price TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
          FOREIGN KEY (source_id) REFERENCES connected_sources(id) ON UPDATE no action ON DELETE cascade
        );
        INSERT INTO positions_new (${carryList})
          SELECT ${carryList} FROM positions;
        DROP TABLE positions;
        ALTER TABLE positions_new RENAME TO positions;
        COMMIT;`);
      await client.execute("PRAGMA foreign_keys = ON");
    }
    await client.execute("PRAGMA user_version = 25");
  }

  if (version < 26) {
    // ADR 0016/0021 (#248): a connected source now materializes ONE asset per
    // occupied liquidity rung (Binance market + term-locked), so each materialized
    // asset carries a `connected_source_id` back-link. It is a plain TEXT column
    // with NO foreign key ON PURPOSE: `connected_sources.asset_id → assets ON
    // DELETE cascade` already points the other way, and a reciprocal FK would form
    // a cascade cycle SQLite rejects. The link is maintained by the store, not a FK.
    //
    // Additive ALTER (try/catch like v20/v22): a fresh DB already has the column
    // from schema-sql, so the duplicate is ignored. Then BACKFILL the existing
    // S1/S2 market assets: each connected source's `asset_id` is its first
    // materialized asset, so link that asset back to its source.
    try {
      await client.executeMultiple(
        "ALTER TABLE assets ADD COLUMN connected_source_id TEXT",
      );
    } catch {}
    // Backfill tolerates a missing `assets`/`connected_sources` table: a minimal
    // synthetic upgrade fixture may stand up only a subset (like the v23/v24
    // indexes). A real DB carries both; a genuine SQL error still surfaces.
    await execToleratingMissingTable(
      client,
      `UPDATE assets SET connected_source_id = (
         SELECT cs.id FROM connected_sources cs WHERE cs.asset_id = assets.id
       ) WHERE id IN (SELECT asset_id FROM connected_sources);`,
    );
    await client.execute("PRAGMA user_version = 26");
  }

  if (version < 27) {
    // #272 (x100 coins): persist the coin's obverse photo thumbnail on each
    // position so the collection renders as a visual gallery — stamped once at
    // sync from the type-detail call the sync already makes (ADR 0017, like
    // fineness/weight). Additive ALTER (try/catch like v20/v22): a fresh DB
    // already has the column from schema-sql, so the duplicate is ignored.
    // Existing rows get NULL (a metal-glyph fallback) and a thumbnail on next sync.
    try {
      await client.executeMultiple(
        "ALTER TABLE positions ADD COLUMN obverse_thumb_url TEXT",
      );
    } catch {}
    await client.execute("PRAGMA user_version = 27");
  }

  if (version < 28) {
    // ADR 0022 (#267): housing becomes the fifth, least-accessible liquidity rung,
    // so every surface classifies the home identically. The frozen snapshot-holding
    // rows that counted as housing sat on the OLD `illiquid` tier (the pre-#267
    // carve), so relabel them to the new `housing` rung — keyed off the frozen
    // `counts_as_housing` flag (#181), the same basis the chart's defensive
    // fallback reads. The snapshots' frozen FIGURES are never touched, so historical
    // net worth, liquid net worth and housing equity stay byte-identical (ADR 0008).
    // The live `assets` table needs NO migration: `tierOfAsset` overrides every
    // property instrument to `housing` at read time, regardless of the stored tier.
    // Tolerates a missing `snapshot_holdings` table (a minimal synthetic fixture),
    // like the other relabel migrations.
    await execToleratingMissingTable(
      client,
      "UPDATE snapshot_holdings SET liquidity_tier = 'housing' WHERE counts_as_housing = 1;",
    );
    await client.execute("PRAGMA user_version = 28");
  }

  if (version < 29) {
    // #305 one-off prune of already-orphaned fossil backfill snapshots. A
    // backfilled snapshot (id prefix `histsnap_`, ADR 0012) exists on a date ONLY
    // because SOME dated fact made it an event date. Older builds never removed
    // such a snapshot when the fact(s) justifying its date were later deleted, so a
    // fossil could persist — frozen with stale holdings — and show a derived
    // holding as "not held" on a day it was held (a phantom dip in the /historico
    // bridge). Going forward the delete ripple prunes these transactionally; this
    // migration clears the ones that already accumulated.
    //
    // It applies the SAME widened "is this date still an event date" rule as the
    // runtime prune (`dateHasJustifyingFact`, PR #326 review): a `histsnap_%` row
    // is pruned ONLY when NO remaining dated fact falls on its `date_key`. The
    // facts covered, each a `histsnap_`-minting source:
    //   - investment operations    → asset_operations.executed_at (date prefix)
    //   - housing valuation anchors → asset_valuations.valuation_date
    //   - balance anchors          → liability_balance_anchors.anchor_date
    //   - interest-rate revisions  → interest_rate_revisions.revision_date
    //   - early repayments         → early_repayments.repayment_date
    //   - coin acquisitions        → positions.purchase_date (kind = 'coin')
    //   - amortization cuotas      → COMPUTED in JS from amortization_plans
    //                                (disbursement, firstPayment + (m−1) months);
    //                                no stored column, so the boundary dates are
    //                                recomputed and excluded via a NOT IN list.
    // Binance / connected-value history is the one source whose dates (curve
    // month-ends) are reconstructed LIVE at sync and never stored, so the SQL
    // context cannot recompute them. CONSERVATIVE fallback (data loss is the
    // failure mode to avoid): if ANY `binance` connected source exists, skip the
    // prune entirely — every `histsnap_%` row is KEPT. The migration thus covers
    // all six stored/computed sources directly and conservatively keeps everything
    // when a Binance history could justify a date it cannot see.
    //
    // A real daily capture (id `snapshot_…`) is never touched. Frozen rows are
    // deleted first, then the parent snapshots — explicit rather than relying on
    // the FK cascade, so the prune is correct even where a minimal upgrade fixture
    // has foreign keys off. Every table read tolerates a missing table.
    const tableExists = async (name: string): Promise<boolean> =>
      (
        await client.execute({
          sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          args: [name],
        })
      ).rows.length > 0;

    // Conservative Binance short-circuit: any binance source → keep everything.
    const hasBinanceSource =
      (await tableExists("connected_sources")) &&
      (
        await client.execute(
          "SELECT 1 FROM connected_sources WHERE adapter = 'binance' LIMIT 1",
        )
      ).rows.length > 0;

    if (!(await tableExists("snapshots"))) {
      await client.execute("PRAGMA user_version = 29");
    } else if (hasBinanceSource) {
      // Keep every histsnap_ row — the Binance history might justify any date.
      await client.execute("PRAGMA user_version = 29");
    } else {
      // Recompute amortization payment-boundary dates (the computed cuota source).
      const amortizationDates = new Set<string>();
      if (await tableExists("amortization_plans")) {
        const plans = (
          await client.execute(
            "SELECT disbursement_date, first_payment_date, term_months FROM amortization_plans",
          )
        ).rows as unknown as {
          disbursement_date: string;
          first_payment_date: string;
          term_months: number;
        }[];
        for (const plan of plans) {
          for (const date of amortizationBoundaryDates(plan)) {
            amortizationDates.add(date);
          }
        }
      }

      // Build the "justified date" predicate from the stored single-column facts
      // that exist in this DB, plus the computed amortization boundaries. Each
      // EXISTS clause is included only when its table is present, so a minimal
      // upgrade fixture lacking a table simply omits that source rather than
      // aborting. The amortization boundaries are bound as parameters in a
      // `date_key NOT IN (...)` list (empty list → the clause is dropped).
      const justifiedClauses: string[] = [];
      if (await tableExists("asset_operations")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM asset_operations
                   WHERE substr(asset_operations.executed_at, 1, 10) = s.date_key)`,
        );
      }
      if (await tableExists("asset_valuations")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM asset_valuations
                   WHERE asset_valuations.valuation_date = s.date_key)`,
        );
      }
      if (await tableExists("liability_balance_anchors")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM liability_balance_anchors
                   WHERE liability_balance_anchors.anchor_date = s.date_key)`,
        );
      }
      if (await tableExists("interest_rate_revisions")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM interest_rate_revisions
                   WHERE interest_rate_revisions.revision_date = s.date_key)`,
        );
      }
      if (await tableExists("early_repayments")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM early_repayments
                   WHERE early_repayments.repayment_date = s.date_key)`,
        );
      }
      if (await tableExists("positions")) {
        justifiedClauses.push(
          `EXISTS (SELECT 1 FROM positions
                   WHERE positions.kind = 'coin' AND positions.purchase_date = s.date_key)`,
        );
      }

      const amortizationList = [...amortizationDates];
      if (amortizationList.length > 0) {
        const placeholders = amortizationList.map(() => "?").join(", ");
        justifiedClauses.push(`s.date_key IN (${placeholders})`);
      }

      // The orphan predicate: a backfilled snapshot justified by NO source. With
      // no justified clauses at all (a fixture lacking every fact table), `NOT (0)`
      // is true for every histsnap_ — there is genuinely nothing left to justify
      // any date, so the prune fires (the v18-era behavior, just widened).
      const justified = justifiedClauses.length > 0 ? justifiedClauses.join(" OR ") : "0";
      const orphanWhere = `s.id LIKE 'histsnap_%' AND NOT (${justified})`;

      if (await tableExists("snapshot_holdings")) {
        await client.execute({
          sql: `DELETE FROM snapshot_holdings
             WHERE snapshot_id IN (
               SELECT s.id FROM snapshots s WHERE ${orphanWhere}
             );`,
          args: amortizationList,
        });
      }
      await client.execute({
        sql: `DELETE FROM snapshots AS s WHERE ${orphanWhere};`,
        args: amortizationList,
      });
      await client.execute("PRAGMA user_version = 29");
    }
  }

  if (version < 30) {
    // #306 one-off cleanup of already-orphaned scope snapshots. A snapshot must
    // exist only for a scope `listScopeOptions` currently offers (ADR 0008 freezes
    // history per scope). Older builds dropped a scope — a household → individual
    // mode switch, a disabled/removed member, a deleted group — without removing
    // that scope's snapshots, so orphaned-scope fossils accumulated: stale frozen
    // rows that contradict the live ledger and that no `rippleHistoricalSnapshots*`
    // path revisits (they all iterate `listScopeOptions`). Going forward the member
    // seams purge these transactionally; this migration clears the backlog.
    //
    // Reproduce `listScopeOptions` in SQL against the stored workspace:
    //   - the `household` scope ALWAYS survives;
    //   - in `individual` mode ONLY `household` is offered → every other scope is
    //     orphaned;
    //   - in `household` mode the active members (`disabled_at IS NULL`) and the
    //     groups are also offered → any other scope is orphaned.
    // The whole rule is one predicate: a snapshot is orphaned when its `scope_id`
    // is neither `household`, nor (in household mode) an active member id, nor (in
    // household mode) a group id. Delete the frozen rows first, then the parent
    // snapshots — explicit rather than relying on the FK cascade, so the prune is
    // correct even where a minimal upgrade fixture has foreign keys off. Tolerates
    // a missing table (a synthetic upgrade fixture may stand up only a subset).
    const orphanScopePredicate = `
      snapshots.scope_id <> 'household'
      AND NOT (
        (SELECT mode FROM workspace WHERE id = 'default') = 'household'
        AND (
          snapshots.scope_id IN (SELECT id FROM members WHERE disabled_at IS NULL)
          OR snapshots.scope_id IN (SELECT id FROM member_groups)
        )
      )`;
    await execToleratingMissingTable(
      client,
      `DELETE FROM snapshot_holdings
       WHERE snapshot_id IN (
         SELECT id FROM snapshots WHERE ${orphanScopePredicate}
       );`,
    );
    await execToleratingMissingTable(
      client,
      `DELETE FROM snapshots WHERE ${orphanScopePredicate};`,
    );
    await client.execute("PRAGMA user_version = 30");
  }

  if (version < 31) {
    // PRD #328 / #334: public opaque IDs for the read-only agent view. IDs are
    // persisted ahead of reads; agent-view queries must never create them lazily.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS agent_view_public_ids (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      public_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );`);
    await client.executeMultiple(
      `CREATE UNIQUE INDEX IF NOT EXISTS agent_view_public_ids_public_id_unique
       ON agent_view_public_ids (public_id);`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'scope', 'household', 'wl_scp_' || lower(hex(randomblob(16)))
      WHERE EXISTS (SELECT 1 FROM workspace WHERE id = 'default');`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'member', id, 'wl_mbr_' || lower(hex(randomblob(16))) FROM members;`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'scope', id, 'wl_scp_' || lower(hex(randomblob(16))) FROM members;`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'member_group', id, 'wl_grp_' || lower(hex(randomblob(16)))
      FROM member_groups;`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'scope', id, 'wl_scp_' || lower(hex(randomblob(16)))
      FROM member_groups;`,
    );
    await client.execute("PRAGMA user_version = 31");
  }

  if (version < 32) {
    // PRD #328 / #335: extend the agent-view public-id registry to holdings —
    // assets AND liabilities share the `holding` entity type. IDs are persisted
    // ahead of reads; agent-view queries must never create them lazily. The
    // `assets`/`liabilities` tables include trashed rows — backfill ALL of them
    // so a trashed holding keeps its public id and a restore stays stable. No
    // schema change is needed (entity_type is TEXT). Missing-table-tolerant like
    // the v31 backfill (a minimal synthetic upgrade fixture may lack a table).
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'holding', id, 'wl_hld_' || lower(hex(randomblob(16))) FROM assets;`,
    );
    await execToleratingMissingTable(
      client,
      `INSERT OR IGNORE INTO agent_view_public_ids
      (entity_type, entity_id, public_id)
      SELECT 'holding', id, 'wl_hld_' || lower(hex(randomblob(16))) FROM liabilities;`,
    );
    await client.execute("PRAGMA user_version = 32");
  }

  return { ranV18Backfill };
}
