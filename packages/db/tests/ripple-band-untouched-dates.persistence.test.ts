/**
 * The ripple band's three outcomes per snapshot (#1590, ADR 0012 / ADR 0020).
 *
 * Every dated-fact family now walks history through ONE primitive (`rippleBand`),
 * and each family's rewrite answers one of three things for a given snapshot:
 * save it, drop it (no holdings remain), or LEAVE IT EXACTLY AS IT IS. The third
 * is the one no other suite pins, and it is the one an over-eager falsy check
 * would silently turn into a delete: an ownership edit reaches only the dates
 * whose household snapshot carries the edited holding (#172/#187/#212), so every
 * earlier date must survive the band untouched — same id, same figures.
 *
 * These tests pin that boundary from both sides on one workspace: the date that
 * does NOT carry the edited fund keeps its snapshot and its figures; the dates
 * that DO carry it are re-weighted to the new split, and no new date appears.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-12";
/** Only the older fund is held here — the edited one does not exist yet. */
const BEFORE_THE_EDITED_FUND = "2024-01-10";
/** Both funds are held here — the edited one appears on this date. */
const AFTER_THE_EDITED_FUND = "2024-05-10";

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

async function snapshotIdAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<string | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.id;
}

/**
 * A household holding two 50/50 funds bought on different dates, so the band
 * carries one snapshot date that predates the fund whose split gets edited.
 */
async function seedTwoFundsBoughtApart(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  for (const id of ["older", "edited"]) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id,
      liquidityTier: "market",
      name: id,
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
    });
  }
  await store.command.recordInvestmentOperation(
    {
      assetId: "older",
      currency: "EUR",
      executedAt: BEFORE_THE_EDITED_FUND,
      feesMinor: 0,
      id: "op_older",
      kind: "buy",
      pricePerUnit: "10.00",
      units: "100",
    },
    { today: TODAY },
  );
  await store.command.recordInvestmentOperation(
    {
      assetId: "edited",
      currency: "EUR",
      executedAt: AFTER_THE_EDITED_FUND,
      feesMinor: 0,
      id: "op_edited",
      kind: "buy",
      pricePerUnit: "20.00",
      units: "100",
    },
    { today: TODAY },
  );
  return store;
}

describe("ripple band — a date the rewrite does not reach (#1590)", () => {
  test("an ownership edit leaves the snapshot predating the fund untouched", async () => {
    const store = await seedTwoFundsBoughtApart();

    const idBefore = await snapshotIdAt(store, BEFORE_THE_EDITED_FUND, "mJ");
    const householdBefore = await grossAt(store, BEFORE_THE_EDITED_FUND, "household");
    const memberBefore = await grossAt(store, BEFORE_THE_EDITED_FUND, "mJ");
    expect(idBefore).toBeDefined();
    expect(memberBefore).toBeDefined();

    await store.command.updateAssetOwnership(
      "edited",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    // Still there — not dropped as if the rewrite had returned "no holdings".
    expect(await snapshotIdAt(store, BEFORE_THE_EDITED_FUND, "mJ")).toBe(idBefore);
    // And byte-identical: the edited fund is not held on this date, so no figure
    // on it can move.
    expect(await grossAt(store, BEFORE_THE_EDITED_FUND, "household")).toBe(
      householdBefore,
    );
    expect(await grossAt(store, BEFORE_THE_EDITED_FUND, "mJ")).toBe(memberBefore);

    store.close();
  });

  test("the dates that DO carry the fund are re-weighted, and no date is added", async () => {
    const store = await seedTwoFundsBoughtApart();

    const datesBefore = (await store.snapshots.readSnapshots("mJ")).map(
      (snap) => snap.dateKey,
    );
    const householdBefore = await grossAt(store, AFTER_THE_EDITED_FUND, "household");
    const memberBefore = await grossAt(store, AFTER_THE_EDITED_FUND, "mJ");

    await store.command.updateAssetOwnership(
      "edited",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    // The member's share of the edited fund grows; the household total, which
    // still owns 100% of both funds, does not move.
    expect(await grossAt(store, AFTER_THE_EDITED_FUND, "household")).toBe(
      householdBefore,
    );
    expect(await grossAt(store, AFTER_THE_EDITED_FUND, "mJ")).toBeGreaterThan(
      memberBefore!,
    );
    // An ownership split has no date axis: the band generates nothing (#172).
    expect(
      (await store.snapshots.readSnapshots("mJ")).map((snap) => snap.dateKey),
    ).toEqual(datesBefore);

    store.close();
  });
});
