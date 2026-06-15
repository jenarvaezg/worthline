import type { Database as DatabaseConnection } from "better-sqlite3";

import { schemaSql } from "./schema-sql";

export const SCHEMA_VERSION = 23;

/** Last calendar day of the given year/month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The YYYY-MM-DD exactly one month after `dateKey`, with the day clamped to the
 * destination month's last valid day — the SAME `addMonths(dateKey, 1)` the
 * amortization engine uses (e.g. 2020-01-31 → 2020-02-29). Inlined here so the
 * v18 backfill reproduces the engine's "first payment one month after start"
 * rule to the day, keeping every existing snapshot byte-identical (ADR 0019).
 */
function addOneMonthClamped(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const zeroBased = month - 1 + 1;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(newYear, newMonth));
  const mm = String(newMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${newYear}-${mm}-${dd}`;
}

export interface MigrateResult {
  /** True when the v18 backfill ran — the two-date model was just applied to
   *  existing rows, so the caller must re-ripple every amortizable debt to
   *  rewrite historical snapshots from the new curve (ADR 0019). */
  ranV18Backfill: boolean;
}

export function migrate(sqlite: DatabaseConnection): MigrateResult {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const version = sqlite.pragma("user_version", { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return { ranV18Backfill: false };

  // Set by the v18 block and returned at the end — must survive later migration
  // steps (v19+) rather than short-circuiting the ladder with an early return.
  let ranV18Backfill = false;

  if (version < 2) {
    const safeSql = schemaSql
      .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
      .replaceAll("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ");
    sqlite.exec(safeSql);
    sqlite.pragma("user_version = 2");
  }

  if (version < 3) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS asset_price_cache (
      asset_id TEXT PRIMARY KEY NOT NULL, currency TEXT NOT NULL, price TEXT NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL, price_date TEXT, fetched_at TEXT NOT NULL,
      freshness_state TEXT DEFAULT 'manual' NOT NULL, stale_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.pragma("user_version = 3");
  }

  if (version < 4) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );`);
    try {
      sqlite.exec("ALTER TABLE assets ADD COLUMN deleted_at TEXT");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE liabilities ADD COLUMN deleted_at TEXT");
    } catch {}
    sqlite.pragma("user_version = 4");
  }

  if (version < 5) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS warning_overrides (
      code TEXT NOT NULL, entity_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (code, entity_id)
    );`);
    sqlite.pragma("user_version = 5");
  }

  if (version < 6) {
    // ADR 0005: monthly closes are now derived (last snapshot of each calendar
    // month), not declared via the is_monthly_close flag. The column is kept for
    // backward compatibility but derivation wins over any persisted flag.
    // No structural change needed — bump version to mark the semantic transition.
    sqlite.pragma("user_version = 6");
  }

  if (version < 7) {
    // ADR 0008: snapshots capture the valued portfolio holding by holding.
    // Label and tier are denormalized on purpose (frozen history) — the only
    // foreign key points at the owning snapshot row, never into holdings.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS snapshot_holdings (
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
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS snapshot_holdings_snapshot_kind_holding_unique
       ON snapshot_holdings (snapshot_id, kind, holding_id);`,
    );
    sqlite.pragma("user_version = 7");
  }

  if (version < 8) {
    try {
      sqlite.exec("ALTER TABLE investment_assets ADD COLUMN price_provider TEXT");
    } catch {}
    sqlite.pragma("user_version = 8");
  }

  if (version < 9) {
    // PRD #108 slice 4: housing valuation anchors + an appreciation rate on the
    // owning asset. The anchor→real_estate invariant is a domain/caller guard,
    // not a SQL constraint (R9).
    try {
      sqlite.exec("ALTER TABLE assets ADD COLUMN annual_appreciation_rate TEXT");
    } catch {}
    sqlite.exec(`CREATE TABLE IF NOT EXISTS asset_valuations (
      id TEXT PRIMARY KEY NOT NULL,
      asset_id TEXT NOT NULL,
      value_minor INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      adjusts_prior_curve INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS asset_valuations_asset_date_unique
       ON asset_valuations (asset_id, valuation_date);`,
    );
    sqlite.pragma("user_version = 9");
  }

  if (version < 10) {
    // PRD #109 slice 7: French-amortization plans + interest-rate revisions, and
    // a debt_model on the owning liability. The plan→amortizable invariant is a
    // domain/caller guard, not a SQL constraint (R9).
    try {
      sqlite.exec("ALTER TABLE liabilities ADD COLUMN debt_model TEXT");
    } catch {}
    sqlite.exec(`CREATE TABLE IF NOT EXISTS amortization_plans (
      id TEXT PRIMARY KEY NOT NULL,
      liability_id TEXT NOT NULL,
      initial_capital_minor INTEGER NOT NULL,
      annual_interest_rate TEXT NOT NULL,
      term_months INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS amortization_plans_liability_unique
       ON amortization_plans (liability_id);`,
    );
    sqlite.exec(`CREATE TABLE IF NOT EXISTS interest_rate_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      revision_date TEXT NOT NULL,
      new_annual_interest_rate TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES amortization_plans(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS interest_rate_revisions_plan_date_unique
       ON interest_rate_revisions (plan_id, revision_date);`,
    );
    sqlite.pragma("user_version = 10");
  }

  if (version < 11) {
    // PRD #109 slice 8: balance anchors for revolving/informal liabilities. The
    // anchor→{revolving,informal} invariant is a domain/caller guard, not a SQL
    // constraint (R9). balance_minor is the TOTAL owed (interest included if any).
    sqlite.exec(`CREATE TABLE IF NOT EXISTS liability_balance_anchors (
      id TEXT PRIMARY KEY NOT NULL,
      liability_id TEXT NOT NULL,
      balance_minor INTEGER NOT NULL,
      anchor_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (liability_id) REFERENCES liabilities(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS liability_balance_anchors_liability_date_unique
       ON liability_balance_anchors (liability_id, anchor_date);`,
    );
    sqlite.pragma("user_version = 11");
  }

  if (version < 12) {
    // ADR 0013: recut the liquidity ladder to four pure-accessibility rungs.
    // `retirement → term-locked` and `housing → illiquid`, applied to live
    // holdings and to the denormalized frozen tier on snapshot-holding rows
    // (ADR 0008). The snapshots' frozen FIGURES are never touched, so historical
    // net worth, liquid net worth and housing equity stay byte-identical.
    sqlite.exec(
      "UPDATE assets SET liquidity_tier = 'term-locked' WHERE liquidity_tier = 'retirement';",
    );
    sqlite.exec(
      "UPDATE assets SET liquidity_tier = 'illiquid' WHERE liquidity_tier = 'housing';",
    );
    sqlite.exec(
      "UPDATE snapshot_holdings SET liquidity_tier = 'term-locked' WHERE liquidity_tier = 'retirement';",
    );
    sqlite.exec(
      "UPDATE snapshot_holdings SET liquidity_tier = 'illiquid' WHERE liquidity_tier = 'housing';",
    );
    sqlite.pragma("user_version = 12");
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
      sqlite.exec("ALTER TABLE assets ADD COLUMN valuation_method TEXT");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE liabilities ADD COLUMN valuation_method TEXT");
    } catch {}
    sqlite.exec(
      `UPDATE assets SET valuation_method = CASE
         WHEN type = 'investment' THEN 'derived'
         WHEN type = 'real_estate' OR is_primary_residence = 1 THEN 'appreciating'
         ELSE 'stored' END;`,
    );
    sqlite.exec(
      `UPDATE liabilities SET valuation_method = CASE debt_model
         WHEN 'amortizable' THEN 'amortized'
         WHEN 'revolving' THEN 'anchored'
         WHEN 'informal' THEN 'anchored'
         ELSE 'stored' END;`,
    );
    sqlite.pragma("user_version = 13");
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
      sqlite.exec("ALTER TABLE assets ADD COLUMN instrument TEXT");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE liabilities ADD COLUMN instrument TEXT");
    } catch {}
    sqlite.exec(
      `UPDATE assets SET instrument = CASE
         WHEN type = 'real_estate' OR is_primary_residence = 1 THEN 'property'
         WHEN type = 'cash' THEN 'current_account'
         WHEN type = 'investment' THEN COALESCE(
           (SELECT CASE WHEN ia.price_provider = 'finect' THEN 'pension_plan' ELSE 'fund' END
            FROM investment_assets ia WHERE ia.asset_id = assets.id),
           'fund')
         ELSE 'other' END;`,
    );
    sqlite.exec(
      `UPDATE liabilities SET instrument = CASE
         WHEN type = 'mortgage' THEN 'mortgage'
         WHEN debt_model = 'revolving' THEN 'credit_card'
         ELSE 'loan' END;`,
    );
    sqlite.pragma("user_version = 14");
  }

  if (version < 15) {
    // PRD #146 slice S4: lump-sum early repayments (amortización anticipada) on
    // an amortization plan. The repayment→amortizable invariant is a
    // domain/caller guard, not a SQL constraint (R9). The unique index keeps one
    // repayment per plan per date; `mode` ∈ {reduce-payment, reduce-term} is
    // enforced in TS, like the other text enums (no CHECK).
    sqlite.exec(`CREATE TABLE IF NOT EXISTS early_repayments (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      repayment_date TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES amortization_plans(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS early_repayments_plan_date_unique
       ON early_repayments (plan_id, repayment_date);`,
    );
    sqlite.pragma("user_version = 15");
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
      sqlite.exec(
        "ALTER TABLE snapshot_holdings ADD COLUMN secures_housing INTEGER NOT NULL DEFAULT 0",
      );
    } catch {}
    sqlite.exec(
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
    sqlite.pragma("user_version = 16");
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
      sqlite.exec(
        "ALTER TABLE snapshot_holdings ADD COLUMN counts_as_housing INTEGER NOT NULL DEFAULT 0",
      );
    } catch {}
    sqlite.exec(
      `UPDATE snapshot_holdings SET counts_as_housing = 1
       WHERE kind = 'asset'
         AND holding_id IN (
           SELECT a.id FROM assets a
           WHERE a.instrument = 'property'
              OR a.type = 'real_estate'
              OR a.is_primary_residence = 1
         );`,
    );
    sqlite.pragma("user_version = 17");
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
    const columns = sqlite.prepare("PRAGMA table_info(amortization_plans)").all() as {
      name: string;
    }[];
    const hasStartDate = columns.some((c) => c.name === "start_date");

    if (hasStartDate) {
      ranV18Backfill = true;
      sqlite.exec("ALTER TABLE amortization_plans ADD COLUMN disbursement_date TEXT");
      sqlite.exec("ALTER TABLE amortization_plans ADD COLUMN first_payment_date TEXT");

      const plans = sqlite
        .prepare("SELECT id, start_date FROM amortization_plans")
        .all() as { id: string; start_date: string }[];
      const backfill = sqlite.prepare(
        "UPDATE amortization_plans SET disbursement_date = ?, first_payment_date = ? WHERE id = ?",
      );
      for (const plan of plans) {
        backfill.run(plan.start_date, addOneMonthClamped(plan.start_date), plan.id);
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
      sqlite.pragma("foreign_keys = OFF");
      sqlite.exec(`BEGIN;
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
      sqlite.pragma("foreign_keys = ON");
    }
    sqlite.pragma("user_version = 18");
  }

  if (version < 19) {
    // PRD #160 / #163 (ADR 0016/0017): connected sources mirror an external
    // account read-only and project their positions into one rolled-up holding.
    // credentials_json + token_json are LOCAL ONLY — never exported (ADR 0016).
    sqlite.exec(`CREATE TABLE IF NOT EXISTS connected_sources (
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
    sqlite.exec(`CREATE TABLE IF NOT EXISTS positions (
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
    sqlite.pragma("user_version = 19");
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
      sqlite.exec("ALTER TABLE positions ADD COLUMN issue_id INTEGER");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE positions ADD COLUMN fineness_millis INTEGER");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE positions ADD COLUMN weight_grams REAL");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE positions ADD COLUMN numismatic_fetched_at TEXT");
    } catch {}
    sqlite.pragma("user_version = 20");
  }

  if (version < 21) {
    // ADR 0017 (#167): persist Numista's stable collected-item id on each
    // position so a wholesale re-sync can tell a genuinely new trade (ripple it
    // into history) from a coin already frozen in past snapshots. Nullable for
    // the rows that predate it; every sync from now on sets it.
    try {
      sqlite.exec("ALTER TABLE positions ADD COLUMN external_id TEXT");
    } catch {}
    sqlite.pragma("user_version = 21");
  }

  if (version < 22) {
    // #215: persist the coin's mint year on each position so the catalogue row
    // shows the coin's year (not its acquisition date). Forward-only, nullable —
    // existing rows get NULL and are repopulated on the next sync.
    try {
      sqlite.exec("ALTER TABLE positions ADD COLUMN year INTEGER");
    } catch {}
    sqlite.pragma("user_version = 22");
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
    // Each statement is independently guarded (like the column-add ALTERs above):
    // every real v<23 DB carries these tables (created at v<2), but minimal
    // synthetic upgrade fixtures may stand up only a subset, so a CREATE INDEX over
    // an absent table must be a no-op rather than aborting the rest of the step.
    try {
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS asset_operations_asset_executed_idx ON asset_operations (asset_id, executed_at, id);",
      );
    } catch {}
    try {
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS audit_log_entity_created_idx ON audit_log (entity_id, created_at);",
      );
    } catch {}
    try {
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS assets_deleted_at_idx ON assets (name) WHERE deleted_at IS NOT NULL;",
      );
    } catch {}
    try {
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS liabilities_deleted_at_idx ON liabilities (name) WHERE deleted_at IS NOT NULL;",
      );
    } catch {}
    sqlite.pragma("user_version = 23");
  }

  return { ranV18Backfill };
}
