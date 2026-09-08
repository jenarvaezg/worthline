import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsqlClient } from "@db/index";
import { migrate } from "@db/migrate";
import { withStoreUnsafe } from "@worthline/db/unsafe-store";
import {
  calculateFireForScope,
  collectHoldingPayouts,
  fireSustainableSpending,
  type ManualAsset,
  type PayoutSchedule,
  scopePassiveIncome,
  type Workspace,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

describe("schema migration v71 (independent incomes)", () => {
  test("preserves FIRE, net coverage, sustainable spending and rental return for the existing Jorge-shaped portfolio", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wl-income-migration-"));
    const databasePath = join(directory, "workspace.sqlite");
    try {
      const before = await withStoreUnsafe(
        async (store) => {
          await store.workspace.initializeWorkspace({
            mode: "individual",
            members: [{ id: "owner", name: "Propietario" }],
          });
          // Sanitized existing regression fixture: 370k of property, 168k market,
          // and 1,550/month rent with 250/month costs. No future pension is seeded.
          for (const asset of [
            { id: "flat", value: 37_000_000, instrument: "property", tier: "illiquid" },
            { id: "fund", value: 16_800_000, instrument: "other", tier: "market" },
          ] as const) {
            await store.assets.createManualAsset({
              id: asset.id,
              name: asset.id,
              type: "manual",
              instrument: asset.instrument,
              currency: "EUR",
              currentValueMinor: asset.value,
              liquidityTier: asset.tier,
              ownership: [{ memberId: "owner", shareBps: 10_000 }],
            });
          }
          await store.payouts.createPayoutSchedule({
            holdingId: "flat",
            label: "Alquiler",
            amountMinor: 155_000,
            expensesMinor: 25_000,
            cadence: "monthly",
            startISO: "2024-01-01",
            endISO: "2026-09-01",
            nature: "passive",
            amountBasis: "real",
            leaseRegime: "residential_long_term",
            rentRevision: "legal_reference",
            rentRevisionReference: "IRAV",
            postMandatoryTermPolicy: "renew_same_real_rent",
          });
          return portfolioFigures(
            await store.assets.readAssets(),
            (await store.workspace.readWorkspace())!,
            await store.payouts.readPayoutSchedules(),
          );
        },
        { databasePath },
      );

      // Restore the historical table and version before reopening through the
      // public store door, which must run the real migration automatically.
      const legacy = openLibsqlClient(databasePath);
      try {
        await legacy.executeMultiple(`
          ALTER TABLE incomes RENAME TO payout_schedules;
          ALTER TABLE payout_schedules DROP COLUMN nature;
          ALTER TABLE payout_schedules DROP COLUMN amount_basis;
          ALTER TABLE payout_schedules DROP COLUMN assumed_contribution_through;
          ALTER TABLE payout_schedules DROP COLUMN provenance;
          ALTER TABLE payout_schedules DROP COLUMN provenance_as_of;
          DROP INDEX incomes_holding_idx;
          CREATE INDEX payout_schedules_holding_idx ON payout_schedules (holding_id, id);
          UPDATE schema_meta SET version = 70;
          PRAGMA user_version = 70;
        `);
      } finally {
        legacy.close();
      }

      const after = await withStoreUnsafe(
        async (store) => {
          expect(await store.payouts.readPayouts()).toEqual([]);
          return portfolioFigures(
            await store.assets.readAssets(),
            (await store.workspace.readWorkspace())!,
            await store.payouts.readPayoutSchedules(),
          );
        },
        { databasePath },
      );
      expect(after).toEqual(before);
      expect(after.fire.context.fireNumberMinor).toBe(60_000_000);
      expect(after.coverage.coverageRatio).toBe(0.65);
      expect(after.spending?.perpetual.total.monthlyMinor).toBe(186_000);
      expect(after.fire.rentReturns.netRentAnnualMinor).toBe(1_560_000);
      expect(after.fire.rentReturns.applied[0]?.rate).toBeCloseTo(0.042162162162, 10);
      expect(after.fire.context.realReturnUsed).toBeCloseTo(0.044609665428, 10);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("moves every legacy declaration verbatim, classifies only migrated rows, and removes the old table", async () => {
    const client = openLibsqlClient(":memory:");
    try {
      await client.executeMultiple(`
        CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
        INSERT INTO assets VALUES ('flat');
        CREATE TABLE payout_schedules (
          id TEXT PRIMARY KEY NOT NULL,
          holding_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          label TEXT NOT NULL, amount_minor INTEGER NOT NULL, expenses_minor INTEGER,
          cadence TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
          lease_regime TEXT, rent_revision TEXT, rent_revision_reference TEXT,
          post_mandatory_term_policy TEXT,
          exclusions_json TEXT DEFAULT '[]' NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
        CREATE INDEX payout_schedules_holding_idx ON payout_schedules (holding_id, id);
        INSERT INTO payout_schedules VALUES
          ('rent', 'flat', 'Alquiler', 65000, 15000, 'monthly', '2024-01-01', '2026-09-01',
           'residential_long_term', 'legal_reference', 'IRAV', 'renew_same_real_rent',
           '["2024-08-01"]', '2024-01-02 03:04:05'),
          ('garage', 'flat', 'Garaje', 10000, NULL, 'quarterly', '2025-01-01', NULL,
           NULL, NULL, NULL, NULL, '[]', '2025-01-02 03:04:05');
        PRAGMA user_version = 70;
      `);
      const legacy = (await client.execute("SELECT * FROM payout_schedules ORDER BY id"))
        .rows;

      await migrate(client);

      expect((await client.execute("SELECT * FROM incomes ORDER BY id")).rows).toEqual(
        legacy.map((row) => ({
          ...row,
          nature: "passive",
          amount_basis: "real",
          assumed_contribution_through: null,
          provenance: null,
          provenance_as_of: null,
        })),
      );
      expect(
        (
          await client.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE 'payout_schedules%'",
          )
        ).rows,
      ).toEqual([]);
      expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);

      await client.execute(`INSERT INTO incomes
        (id, label, amount_minor, cadence, start_date)
        VALUES ('pension', 'Pensión', 180000, 'monthly', '2035-01-01')`);
      await migrate(client);
      expect(
        (await client.execute("SELECT * FROM incomes WHERE id = 'pension'")).rows[0],
      ).toMatchObject({
        holding_id: null,
        nature: null,
        amount_basis: null,
        assumed_contribution_through: null,
        provenance: null,
        provenance_as_of: null,
      });
      expect(
        (await client.execute("SELECT count(*) AS count FROM incomes")).rows[0],
      ).toEqual({ count: 3 });
      await client.execute("DELETE FROM assets WHERE id = 'flat'");
      expect((await client.execute("SELECT id FROM incomes")).rows).toEqual([
        { id: "pension" },
      ]);
    } finally {
      client.close();
    }
  });
});

function portfolioFigures(
  assets: ManualAsset[],
  workspace: Workspace,
  schedules: PayoutSchedule[],
) {
  const todayISO = "2026-08-18";
  const fire = calculateFireForScope(
    {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      currentAge: 63,
      targetRetirementAge: 68,
    },
    assets,
    [],
    workspace,
    "owner",
    0,
    { rents: { schedules, todayISO } },
  );
  return {
    fire,
    spending: fireSustainableSpending(fire),
    coverage: scopePassiveIncome({
      payoutsByHolding: collectHoldingPayouts([], schedules, todayISO),
      holdings: assets,
      scopeMemberIds: new Set(["owner"]),
      monthlySpendingMinor: 200_000,
      todayISO,
    }),
  };
}
