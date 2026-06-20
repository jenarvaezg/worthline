/**
 * Enforce "live scopes only": purge orphaned-scope snapshots when scopes change
 * (#306).
 *
 * A snapshot must exist only for a scope `listScopeOptions` currently offers. A
 * scope is dropped when the workspace mode switches household → individual (the
 * member/group scopes are no longer offered) or when a member is removed
 * (disabled or hard-deleted) — but the dropped scope's snapshots used to stay
 * frozen in the DB, rotting into inconsistencies no `rippleHistoricalSnapshots*`
 * path (they all iterate `listScopeOptions`) ever revisits.
 *
 * These tests pin the enforcement:
 *  - disabling a member purges THAT member's snapshots + frozen rows, while the
 *    household scope's are never touched;
 *  - hard-deleting a member likewise purges its scope;
 *  - after any scope-dropping change, no snapshot has a `scope_id` absent from
 *    `listScopeOptions`;
 *  - a household → individual collapse (live scopes shrink to just household)
 *    purges every per-member / per-group scope's snapshots, household survives.
 */
import { listScopeOptions } from "@worthline/domain";
import type { NetWorthSnapshot, SnapshotHoldingRow } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

async function saveScopeSnapshot(
  store: WorthlineStore,
  scopeId: string,
  scopeLabel: string,
  dateKey: string,
): Promise<void> {
  const holding: SnapshotHoldingRow = {
    countsAsHousing: false,
    holdingId: "cash",
    kind: "asset",
    label: "Cuenta",
    liquidityTier: "cash",
    securesHousing: false,
    valueMinor: 1_000_00,
  };
  const snapshot: NetWorthSnapshot = {
    capturedAt: `${dateKey}T20:00:00.000Z`,
    dateKey,
    debts: { amountMinor: 0, currency: "EUR" },
    grossAssets: { amountMinor: 1_000_00, currency: "EUR" },
    housingEquity: { amountMinor: 0, currency: "EUR" },
    id: `snapshot_${scopeId}_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: { amountMinor: 1_000_00, currency: "EUR" },
    monthKey: dateKey.slice(0, 7),
    scopeId,
    scopeLabel,
    totalNetWorth: { amountMinor: 1_000_00, currency: "EUR" },
    warnings: [],
  };
  await store.snapshots.saveSnapshot({ holdings: [holding], replace: false, snapshot });
}

async function scopeIdsWithSnapshots(store: WorthlineStore): Promise<string[]> {
  return [
    ...new Set((await store.snapshots.readSnapshots()).map((s) => s.scopeId)),
  ].sort();
}

describe("purge orphaned-scope snapshots when scopes change (#306)", () => {
  test("disabling a member purges that member's snapshots and frozen rows; household survives", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });

    await saveScopeSnapshot(store, "household", "Hogar", "2024-01-10");
    await saveScopeSnapshot(store, "mJ", "Jose", "2024-01-10");
    await saveScopeSnapshot(store, "mA", "Ana", "2024-01-10");

    expect(await scopeIdsWithSnapshots(store)).toEqual(["household", "mA", "mJ"]);

    await store.workspace.disableMember("mA", new Date().toISOString());

    // Ana's scope is no longer offered → its snapshot is purged.
    expect(await scopeIdsWithSnapshots(store)).toEqual(["household", "mJ"]);
    // ...and its frozen holding rows go too.
    expect(await store.snapshots.readSnapshotHoldings({ scopeId: "mA" })).toEqual([]);
    // The household scope's snapshot is intact (canonical history).
    expect((await store.snapshots.readSnapshots("household")).length).toBeGreaterThan(0);
    // Jose's snapshot (still a live scope) is intact.
    expect((await store.snapshots.readSnapshots("mJ")).length).toBeGreaterThan(0);
    store.close();
  });

  test("hard-deleting a member purges that member's scope snapshots", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });

    await saveScopeSnapshot(store, "household", "Hogar", "2024-01-10");
    await saveScopeSnapshot(store, "mA", "Ana", "2024-01-10");

    // Hard delete requires the member to be disabled and own no holding.
    await store.workspace.disableMember("mA", new Date().toISOString());
    // disableMember already purged mA — re-seed to prove hardDelete purges too.
    await saveScopeSnapshot(store, "mA", "Ana", "2024-02-10");
    expect(await scopeIdsWithSnapshots(store)).toContain("mA");

    const changes = await store.workspace.hardDeleteMember("mA");
    expect(changes).toBe(1);

    expect(await scopeIdsWithSnapshots(store)).toEqual(["household"]);
    expect(await store.snapshots.readSnapshotHoldings({ scopeId: "mA" })).toEqual([]);
    store.close();
  });

  test("after a scope-dropping change, no snapshot has a scope_id absent from listScopeOptions", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      // The group references only the member that stays active — a group cannot
      // reference a disabled member (createWorkspace would reject the read).
      groups: [{ id: "gP", memberIds: ["mJ"], name: "Solo Jose" }],
      mode: "household",
    });

    await saveScopeSnapshot(store, "household", "Hogar", "2024-01-10");
    await saveScopeSnapshot(store, "mJ", "Jose", "2024-01-10");
    await saveScopeSnapshot(store, "mA", "Ana", "2024-01-10");
    await saveScopeSnapshot(store, "gP", "Solo Jose", "2024-01-10");

    await store.workspace.disableMember("mA", new Date().toISOString());

    const workspace = (await store.workspace.readWorkspace())!;
    const liveScopeIds = new Set(listScopeOptions(workspace).map((o) => o.id));
    for (const scopeId of await scopeIdsWithSnapshots(store)) {
      expect(liveScopeIds.has(scopeId)).toBe(true);
    }
    store.close();
  });

  test("collapsing toward the household scope purges every dropped per-member scope; household survives", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
        { id: "mB", name: "Bea" },
      ],
      mode: "household",
    });

    await saveScopeSnapshot(store, "household", "Hogar", "2024-01-10");
    await saveScopeSnapshot(store, "mJ", "Jose", "2024-01-10");
    await saveScopeSnapshot(store, "mA", "Ana", "2024-01-10");
    await saveScopeSnapshot(store, "mB", "Bea", "2024-01-10");

    // Disabling the other members collapses the offered scopes toward household
    // (the same shrink a household → individual switch produces): every dropped
    // member scope's snapshots are purged, only household + the survivor remain.
    await store.workspace.disableMember("mA", new Date().toISOString());
    await store.workspace.disableMember("mB", new Date().toISOString());

    expect(await scopeIdsWithSnapshots(store)).toEqual(["household", "mJ"]);
    expect(
      (await store.snapshots.readSnapshotHoldings({ scopeId: "household" })).length,
    ).toBe(1);
    expect(await store.snapshots.readSnapshotHoldings({ scopeId: "mA" })).toEqual([]);
    expect(await store.snapshots.readSnapshotHoldings({ scopeId: "mB" })).toEqual([]);
    store.close();
  });
});
