/**
 * Integration test for the payout attribution actions (PRD #652 S1, #656, ADR
 * 0054) via the `_store` injection seam. Proves the create → read-back → delete
 * round-trip for both one-off payouts and declared schedules, plus the schedule
 * "terminar hoy" (end) and "excluir mes" (exclusion toggle) affordances. A payout
 * is attribution, never a figure — nothing here touches a snapshot or ripple.
 * Prior art: inversiones/exposure-profile-action.test.ts.
 */

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  createPayoutAction,
  createPayoutScheduleAction,
  deletePayoutAction,
  deletePayoutScheduleAction,
  updatePayoutScheduleAction,
} from "./actions";

const HOLDING = "h1";

async function seedHolding(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: HOLDING,
    isin: "IE00B4L5Y983",
    liquidityTier: "market",
    name: "Fondo distribuidor",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    providerSymbol: "SWDA",
  });
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("currentUrl", `/patrimonio/${HOLDING}/editar`);
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

/** Run an action and return its NEXT_REDIRECT digest (the redirect URL). */
async function run(
  action: (id: string, fd: FormData, store: WorthlineStore) => Promise<void>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(HOLDING, fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

describe("createPayoutAction / deletePayoutAction", () => {
  test("creates a one-off payout, reads it back, then deletes it", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const digest = await run(
      createPayoutAction,
      form({ dateISO: "2026-05-20", amount: "340,50", note: "Dividendo" }),
      store,
    );
    expect(digest).toContain("ok=payout_saved");

    const [payout] = await store.payouts.readPayoutsForHolding(HOLDING);
    expect(payout).toMatchObject({
      holdingId: HOLDING,
      dateISO: "2026-05-20",
      amountMinor: 34050,
      note: "Dividendo",
    });

    const del = await run(deletePayoutAction, form({ payoutId: payout!.id }), store);
    expect(del).toContain("ok=payout_deleted");
    expect(await store.payouts.readPayoutsForHolding(HOLDING)).toHaveLength(0);
  });

  test("rejects a non-positive amount with the section error, nothing saved", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const digest = await run(
      createPayoutAction,
      form({ dateISO: "2026-05-20", amount: "0" }),
      store,
    );
    expect(digest).toContain("error=");
    expect(decodeURIComponent(digest)).toMatch(/mayor.que.cero/);
    expect(await store.payouts.readPayoutsForHolding(HOLDING)).toHaveLength(0);
  });
});

describe("payout schedule actions", () => {
  test("creates a schedule, ends it, excludes a month, then deletes it", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const created = await run(
      createPayoutScheduleAction,
      form({
        label: "Alquiler piso",
        amount: "1000",
        cadence: "monthly",
        startISO: "2024-01-01",
      }),
      store,
    );
    expect(created).toContain("ok=payout_schedule_saved");

    const [schedule] = await store.payouts.readPayoutSchedulesForHolding(HOLDING);
    expect(schedule).toMatchObject({
      holdingId: HOLDING,
      label: "Alquiler piso",
      amountMinor: 100000,
      cadence: "monthly",
      startISO: "2024-01-01",
      endISO: null,
      exclusions: [],
    });

    // "terminar hoy" — set a retroactive end.
    const ended = await run(
      updatePayoutScheduleAction,
      form({ scheduleId: schedule!.id, endISO: "2026-02-01" }),
      store,
    );
    expect(ended).toContain("ok=payout_schedule_updated");
    expect((await store.payouts.readPayoutSchedulesForHolding(HOLDING))[0]?.endISO).toBe(
      "2026-02-01",
    );

    // "excluir mes" — toggle a single occurrence off.
    await run(
      updatePayoutScheduleAction,
      form({ scheduleId: schedule!.id, excludeDate: "2025-06-01" }),
      store,
    );
    expect(
      (await store.payouts.readPayoutSchedulesForHolding(HOLDING))[0]?.exclusions,
    ).toEqual(["2025-06-01"]);

    // Toggling the same date again re-includes it.
    await run(
      updatePayoutScheduleAction,
      form({ scheduleId: schedule!.id, excludeDate: "2025-06-01" }),
      store,
    );
    expect(
      (await store.payouts.readPayoutSchedulesForHolding(HOLDING))[0]?.exclusions,
    ).toEqual([]);

    const deleted = await run(
      deletePayoutScheduleAction,
      form({ scheduleId: schedule!.id }),
      store,
    );
    expect(deleted).toContain("ok=payout_schedule_deleted");
    expect(await store.payouts.readPayoutSchedulesForHolding(HOLDING)).toHaveLength(0);
  });

  test("rejects an unknown cadence, nothing saved", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const digest = await run(
      createPayoutScheduleAction,
      form({ label: "X", amount: "10", cadence: "daily", startISO: "2024-01-01" }),
      store,
    );
    expect(digest).toContain("error=");
    expect(decodeURIComponent(digest)).toMatch(/cadencia/i);
    expect(await store.payouts.readPayoutSchedulesForHolding(HOLDING)).toHaveLength(0);
  });
});
