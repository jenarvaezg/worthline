/**
 * The v56 one-shot seed of the declared FIRE savings capacity (#1416, ADR 0074).
 *
 * The FIRE projection used to derive its monthly savings from the contribution plan
 * whenever the plan had rows, keeping the user's declared scalar only as a fallback.
 * Jorge declared 1.500 €/mes and the app projected the 100 €/mes of his single
 * pension-plan row. That derivation is gone — but cutting it would drop any scope
 * that lived off it and never typed a scalar straight to 0 €/month, which is the
 * same silent failure in the other direction.
 *
 * So the seed PRESERVES and never invents: the only figure it writes is the plan's
 * own active total. These tests pin both halves of that — what it writes, and the
 * shapes it deliberately leaves alone because they already project 0 today.
 *
 * Every case upgrades a real v56 DB back down to v55 and reopens it, because the
 * seed is gated on the `pending` row the v56 ladder step enqueues.
 */

import { openLibsqlClient } from "@db/index";
import { createStoreFromSqlite } from "@db/testing";
import type { Client } from "@libsql/client";
import type { FireScopeConfig } from "@worthline/domain";
import { fixedClock } from "@worthline/domain";
import { describe, expect, test } from "vitest";

/** The seed's clock, pinned: an active row and an expired one are relative to it. */
const NOW = "2026-08-18T09:00:00.000Z";
const clock = fixedClock(NOW);
const FUTURE = "2026-12-31";
const PAST = "2026-07-31";

async function storedFireConfig(
  client: Client,
): Promise<Record<string, FireScopeConfig>> {
  const row = await client.execute(
    "SELECT value FROM app_settings WHERE key = 'fire.config'",
  );
  return JSON.parse(String(row.rows[0]!.value)) as Record<string, FireScopeConfig>;
}

async function seedMarker(client: Client): Promise<string | undefined> {
  const row = await client.execute(
    "SELECT value FROM app_settings WHERE key = 'fire.capacity_seed.v56'",
  );
  return row.rows[0] === undefined ? undefined : String(row.rows[0].value);
}

/** Reopen the same DB one schema version behind, so the v56 ladder step runs. */
async function reopenFromV55(client: Client) {
  await client.execute("UPDATE schema_meta SET version = 55");
  return createStoreFromSqlite(client, { clock });
}

interface PlanRow {
  /** Monthly money amount, or units when `units` is set. */
  minor?: number;
  units?: string;
  /** Give the destination a cached price, so a units row is convertible. */
  priced?: boolean;
  expired?: boolean;
}

async function seedWorkspace(options: {
  declaredMinor?: number;
  rows?: PlanRow[];
  /** A second scope (a member group) carrying its own FIRE config. */
  secondScopeId?: string;
}): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(client, { clock });
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJorge", name: "Jorge", birthYear: 1963 }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJorge", shareBps: 10_000 }],
  });
  // A single 200.000 € month: the figure a measured-savings fallback would have
  // written into the config (200.000 €/mes). Nothing here may read it.
  await store.command.recordInvestmentOperation(
    {
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-08-03",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units: "2000",
    },
    { today: NOW.slice(0, 10) },
  );

  const config: FireScopeConfig = {
    monthlySpendingMinor: 2_000_00,
    safeWithdrawalRate: 0.04,
    ...(options.declaredMinor === undefined
      ? {}
      : { monthlySavingsCapacityMinor: options.declaredMinor }),
  };
  await store.saveFireConfig("household", config);
  if (options.secondScopeId) {
    await store.saveFireConfig(options.secondScopeId, config);
  }

  for (const [index, row] of (options.rows ?? []).entries()) {
    if (row.priced) {
      await store.operations.upsertPrice({
        assetId: "asset_fund",
        currency: "EUR",
        fetchedAt: NOW,
        freshnessState: "manual",
        price: "100",
        source: "manual",
      });
    }
    for (const scopeId of ["household", options.secondScopeId].filter(
      (id): id is string => id !== undefined,
    )) {
      await store.contributionPlan.createPlannedContribution({
        scopeId,
        destinationHoldingId: "asset_fund",
        amount:
          row.units === undefined
            ? { mode: "money", value: row.minor ?? 100_00 }
            : { mode: "units", value: row.units },
        cadence: { kind: "monthly", dayOfMonth: 1 },
        startDate: "2026-01-01",
        endDate: row.expired ? PAST : FUTURE,
      });
    }
    void index;
  }
  return client;
}

describe("v56 seed — declared FIRE savings capacity (#1416)", () => {
  test("writes the plan's active total for a scope with no declared scalar", async () => {
    const client = await seedWorkspace({ rows: [{ minor: 100_00 }] });

    await reopenFromV55(client);

    expect(await storedFireConfig(client)).toEqual({
      household: {
        monthlySpendingMinor: 2_000_00,
        safeWithdrawalRate: 0.04,
        monthlySavingsCapacityMinor: 100_00,
        monthlySavingsCapacitySeededFromPlan: true,
      },
    });
  });

  test("sums the active rows only, ignoring the ones that have lapsed", async () => {
    const client = await seedWorkspace({
      rows: [{ minor: 100_00 }, { minor: 250_00 }, { minor: 900_00, expired: true }],
    });

    await reopenFromV55(client);

    expect((await storedFireConfig(client)).household?.monthlySavingsCapacityMinor).toBe(
      350_00,
    );
  });

  test("leaves a plan whose every row has lapsed alone — it already projects 0", async () => {
    // The old code summed an expired plan to 0 too, so nothing is lost. Writing the
    // measured 200.000 €/mes here would invent a figure two orders of magnitude off.
    const client = await seedWorkspace({ rows: [{ minor: 100_00, expired: true }] });

    await reopenFromV55(client);

    const config = (await storedFireConfig(client)).household!;
    expect(config.monthlySavingsCapacityMinor).toBeUndefined();
    expect(config.monthlySavingsCapacitySeededFromPlan).toBeUndefined();
  });

  test("leaves an unpriceable units row alone — the old resolver fell back to 0", async () => {
    const client = await seedWorkspace({ rows: [{ units: "2" }] });

    await reopenFromV55(client);

    const config = (await storedFireConfig(client)).household!;
    expect(config.monthlySavingsCapacityMinor).toBeUndefined();
    expect(config.monthlySavingsCapacitySeededFromPlan).toBeUndefined();
  });

  test("converts a units row when its destination has a price", async () => {
    const client = await seedWorkspace({ rows: [{ units: "2", priced: true }] });

    await reopenFromV55(client);

    expect((await storedFireConfig(client)).household?.monthlySavingsCapacityMinor).toBe(
      200_00,
    );
  });

  test("leaves a declared scalar alone — it is already the figure that counts", async () => {
    const client = await seedWorkspace({
      declaredMinor: 1_500_00,
      rows: [{ minor: 100_00 }],
    });

    await reopenFromV55(client);

    const config = (await storedFireConfig(client)).household!;
    expect(config.monthlySavingsCapacityMinor).toBe(1_500_00);
    expect(config.monthlySavingsCapacitySeededFromPlan).toBeUndefined();
  });

  test("does not seed a scope with no contribution plan", async () => {
    const client = await seedWorkspace({});

    await reopenFromV55(client);

    const config = (await storedFireConfig(client)).household!;
    expect(config.monthlySavingsCapacityMinor).toBeUndefined();
    expect(config.monthlySavingsCapacitySeededFromPlan).toBeUndefined();
  });

  test("seeds each scope from its OWN plan, never a workspace-wide figure", async () => {
    const client = await seedWorkspace({
      rows: [{ minor: 100_00 }],
      secondScopeId: "group:pareja",
    });

    await reopenFromV55(client);

    const stored = await storedFireConfig(client);
    expect(stored.household?.monthlySavingsCapacityMinor).toBe(100_00);
    expect(stored["group:pareja"]?.monthlySavingsCapacityMinor).toBe(100_00);
  });

  test("never writes back the derived age (#1415): it reads the STORED config", async () => {
    // `readFireConfig` resolves `currentAge` from the member's birth date on every
    // read. Seeding through that reader would freeze the age this repo just un-froze.
    const client = await seedWorkspace({ rows: [{ minor: 100_00 }] });

    await reopenFromV55(client);

    expect((await storedFireConfig(client)).household).not.toHaveProperty("currentAge");
  });

  test("retires its own marker, so it runs once and then costs one lookup", async () => {
    const client = await seedWorkspace({ rows: [{ minor: 100_00 }] });

    await reopenFromV55(client);
    expect(await seedMarker(client)).toBe(NOW);

    // A later save blanking the field must NOT be re-seeded from the plan.
    const store = await createStoreFromSqlite(client, { clock });
    await store.saveFireConfig("household", {
      monthlySpendingMinor: 2_000_00,
      safeWithdrawalRate: 0.04,
    });
    await createStoreFromSqlite(client, { clock });

    const config = (await storedFireConfig(client)).household!;
    expect(config.monthlySavingsCapacityMinor).toBeUndefined();
    expect(config.monthlySavingsCapacitySeededFromPlan).toBeUndefined();
  });

  test("a fresh DB never gets a marker, so it never pays the lookup", async () => {
    const client = openLibsqlClient(":memory:");
    await createStoreFromSqlite(client, { clock });

    expect(await seedMarker(client)).toBeUndefined();
  });
});
