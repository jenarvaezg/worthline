/**
 * Payout CRUD round-trip (PRD #652 / ADR 0054): one-off payouts and payout
 * schedules persist through create / read / update / delete against a real SQLite
 * database migrated to the current schema version. Schedules store only the
 * declaration (amount, cadence, start, optional end, exclusions) — occurrences are
 * derived on read and are NEVER materialized as rows.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkspaceExport } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStoreUnsafe } from "./unsafe-store";

async function freshStore(): Promise<
  Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>
> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-payout-")), "w.sqlite");
  const store = await createWorthlineStoreUnsafe({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  for (const id of ["h1", "h2"]) {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id,
      liquidityTier: "market",
      name: id,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "investment",
    });
  }
  return store;
}

describe("payout CRUD", () => {
  it("creates a one-off payout with a generated id and reads it back", async () => {
    const store = await freshStore();
    const created = await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-11-20",
      amountMinor: 34000,
      note: "Dividendo extraordinario",
    });
    expect(created.id).toEqual(expect.any(String));

    const forHolding = await store.payouts.readPayoutsForHolding("h1");
    expect(forHolding).toEqual([
      {
        id: created.id,
        holdingId: "h1",
        dateISO: "2025-11-20",
        amountMinor: 34000,
        note: "Dividendo extraordinario",
      },
    ]);
  });

  it("omits an absent note rather than storing null", async () => {
    const store = await freshStore();
    const created = await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-05-10",
      amountMinor: 27500,
    });
    const [payout] = await store.payouts.readPayoutsForHolding("h1");
    expect(payout).toEqual({
      id: created.id,
      holdingId: "h1",
      dateISO: "2025-05-10",
      amountMinor: 27500,
    });
    expect("note" in payout!).toBe(false);
  });

  it("lists all payouts ordered by date then id, scoped reads by holding", async () => {
    const store = await freshStore();
    await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-06-01",
      amountMinor: 100,
    });
    await store.payouts.createPayout({
      holdingId: "h2",
      dateISO: "2025-01-01",
      amountMinor: 200,
    });

    const all = await store.payouts.readPayouts();
    expect(all.map((p) => p.dateISO)).toEqual(["2025-01-01", "2025-06-01"]);
    expect(
      (await store.payouts.readPayoutsForHolding("h1")).map((p) => p.dateISO),
    ).toEqual(["2025-06-01"]);
  });

  it("deletes a payout by id", async () => {
    const store = await freshStore();
    const p = await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-06-01",
      amountMinor: 100,
    });
    await store.payouts.deletePayout(p.id);
    expect(await store.payouts.readPayouts()).toEqual([]);
  });
});

describe("payout schedule CRUD", () => {
  it("creates a schedule (exclusions default to []) and reads it back", async () => {
    const store = await freshStore();
    const created = await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler piso",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
    });
    expect(created.id).toEqual(expect.any(String));

    const schedules = await store.payouts.readPayoutSchedulesForHolding("h1");
    expect(schedules).toEqual([
      {
        id: created.id,
        holdingId: "h1",
        label: "Alquiler piso",
        amountMinor: 100000,
        // Not declared, not zero (#1448): a rent with no declared cost derives no
        // FIRE rate at all, so the two have to stay distinguishable in storage.
        expensesMinor: null,
        cadence: "monthly",
        startISO: "2024-01-01",
        endISO: null,
        // The lease terms, undeclared for the same reason (#1521): NULL says «nadie
        // lo ha dicho», and the engine then behaves exactly as it did before v66.
        leaseRegime: null,
        rentRevision: null,
        rentRevisionReference: null,
        postMandatoryTermPolicy: null,
        exclusions: [],
      },
    ]);
  });

  it("round-trips declared expenses, and tells a declared 0 from an absence", async () => {
    const store = await freshStore();
    const withCosts = await store.payouts.createPayoutSchedule({
      amountMinor: 100_000,
      cadence: "monthly",
      expensesMinor: 25_000,
      holdingId: "h1",
      label: "Alquiler con gastos",
      startISO: "2024-01-01",
    });
    const free = await store.payouts.createPayoutSchedule({
      amountMinor: 50_000,
      cadence: "monthly",
      expensesMinor: 0,
      holdingId: "h1",
      label: "Alquiler sin gastos",
      startISO: "2024-01-01",
    });

    const byId = new Map(
      (await store.payouts.readPayoutSchedulesForHolding("h1")).map((row) => [
        row.id,
        row.expensesMinor,
      ]),
    );
    expect(byId.get(withCosts.id)).toBe(25_000);
    expect(byId.get(free.id)).toBe(0);
    expect(free.expensesMinor).toBe(0);
  });

  it("updates the declared expenses, and clears them back to 'not declared'", async () => {
    const store = await freshStore();
    const schedule = await store.payouts.createPayoutSchedule({
      amountMinor: 100_000,
      cadence: "monthly",
      holdingId: "h1",
      label: "Alquiler",
      startISO: "2024-01-01",
    });

    await store.payouts.updatePayoutSchedule(schedule.id, { expensesMinor: 30_000 });
    expect(
      (await store.payouts.readPayoutSchedulesForHolding("h1"))[0]?.expensesMinor,
    ).toBe(30_000);

    await store.payouts.updatePayoutSchedule(schedule.id, { expensesMinor: null });
    expect(
      (await store.payouts.readPayoutSchedulesForHolding("h1"))[0]?.expensesMinor,
    ).toBeNull();
  });

  it("updates a schedule: retroactive end and per-occurrence exclusions", async () => {
    const store = await freshStore();
    const s = await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Cupón",
      amountMinor: 20000,
      cadence: "quarterly",
      startISO: "2024-06-01",
    });

    await store.payouts.updatePayoutSchedule(s.id, {
      endISO: "2026-02-01",
      exclusions: ["2025-06-01"],
    });

    const [updated] = await store.payouts.readPayoutSchedulesForHolding("h1");
    expect(updated).toMatchObject({
      endISO: "2026-02-01",
      exclusions: ["2025-06-01"],
      amountMinor: 20000,
      label: "Cupón",
    });
  });

  it("does NOT materialize schedule occurrences as payout rows", async () => {
    const store = await freshStore();
    await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2020-01-01",
    });
    // Years of monthly occurrences exist by derivation, but storage holds zero payout rows.
    expect(await store.payouts.readPayouts()).toEqual([]);
    expect(await store.payouts.readPayoutSchedules()).toHaveLength(1);
  });

  it("export/import: carries payouts and schedules (incl. exclusions) into a fresh workspace", async () => {
    const store = await freshStore();
    await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-11-20",
      amountMinor: 34000,
      note: "Dividendo",
    });
    await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
      endISO: "2026-02-01",
      exclusions: ["2024-08-01"],
    });

    const doc = await store.workspace.exportWorkspace();
    expect(doc.payouts).toHaveLength(1);
    expect(doc.payoutSchedules).toHaveLength(1);
    // Only the declaration travels — occurrences are never materialized.
    expect(doc.payoutSchedules[0]).toMatchObject({
      exclusions: ["2024-08-01"],
      endISO: "2026-02-01",
      cadence: "monthly",
    });

    const target = await freshStore();
    await target.workspace.importWorkspace(doc);

    expect(await target.payouts.readPayouts()).toEqual(await store.payouts.readPayouts());
    expect(await target.payouts.readPayoutSchedules()).toEqual(
      await store.payouts.readPayoutSchedules(),
    );
  });

  it("the lease terms round-trip through the transfer document (#1521)", async () => {
    const store = await freshStore();
    await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
      endISO: "2026-09-01",
      leaseRegime: "residential_long_term",
      rentRevision: "legal_reference",
      rentRevisionReference: "IRAV",
      postMandatoryTermPolicy: "renew_same_real_rent",
    });

    const doc = await store.workspace.exportWorkspace();
    expect(doc.payoutSchedules[0]).toMatchObject({
      leaseRegime: "residential_long_term",
      postMandatoryTermPolicy: "renew_same_real_rent",
      rentRevision: "legal_reference",
      rentRevisionReference: "IRAV",
    });

    const target = await freshStore();
    await target.workspace.importWorkspace(doc);

    expect(await target.payouts.readPayoutSchedules()).toEqual(
      await store.payouts.readPayoutSchedules(),
    );
  });

  it("a schedule declared with no lease terms keeps every one of them null (#1521)", async () => {
    const store = await freshStore();
    const created = await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
    });

    // Not a default in disguise: the engine goes on behaving as it did before v66.
    expect(created).toMatchObject({
      leaseRegime: null,
      postMandatoryTermPolicy: null,
      rentRevision: null,
      rentRevisionReference: null,
    });
    expect((await store.payouts.readPayoutSchedules())[0]).toEqual(created);
  });

  it("export/import: an older export omitting the payout sections defaults to []", async () => {
    const store = await freshStore();
    const doc = await store.workspace.exportWorkspace();
    const legacy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    delete legacy.payouts;
    delete legacy.payoutSchedules;

    const parsed = parseWorkspaceExport(legacy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.payouts).toEqual([]);
      expect(parsed.value.payoutSchedules).toEqual([]);
    }
  });

  it("deletes a schedule by id", async () => {
    const store = await freshStore();
    const s = await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
    });
    await store.payouts.deletePayoutSchedule(s.id);
    expect(await store.payouts.readPayoutSchedules()).toEqual([]);
  });

  it("cascades: hard-deleting the holding removes its payouts and schedules", async () => {
    const store = await freshStore();
    await store.payouts.createPayout({
      holdingId: "h1",
      dateISO: "2025-06-01",
      amountMinor: 100,
    });
    await store.payouts.createPayoutSchedule({
      holdingId: "h1",
      label: "Alquiler",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
    });

    await store.assets.softDeleteAsset("h1", new Date().toISOString());
    await store.emptyTrash();

    expect(await store.payouts.readPayouts()).toEqual([]);
    expect(await store.payouts.readPayoutSchedules()).toEqual([]);
  });
});
