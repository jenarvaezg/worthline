import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import type { OwnershipShare } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

import {
  confirmHoldingRemovalProposalAction,
  confirmHoldingRestorationProposalAction,
  discardHoldingRemovalProposalAction,
} from "./holding-trash-proposal-action";
import {
  buildHoldingRemovalProposal,
  buildHoldingRestorationProposal,
} from "./holding-trash-proposals";

const TODAY = "2026-07-18";
const clock = { now: () => "2026-07-18T09:00:00.000Z", today: () => TODAY };
const SOLO: OwnershipShare[] = [{ memberId: "m", shareBps: 10_000 }];

const openStores = new Set<WorthlineStore>();
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

async function seed(
  members: { id: string; name: string }[] = [{ id: "m", name: "Jose" }],
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  openStores.add(store);
  await store.workspace.initializeWorkspace({
    members,
    mode: members.length > 1 ? "household" : "individual",
  });
  return store;
}

async function createCash(
  store: WorthlineStore,
  id: string,
  name: string,
  valueMinor: number,
  ownership: OwnershipShare[] = SOLO,
): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: valueMinor,
    id,
    instrument: "current_account",
    liquidityTier: "cash",
    name,
    ownership,
    type: "cash",
  });
}

async function publicIdOf(store: WorthlineStore, internalId: string): Promise<string> {
  const row = (await store.agentView.readPublicIds()).find(
    (item) => item.entityType === "holding" && item.entityId === internalId,
  );
  if (!row) throw new Error(`no public id for ${internalId}`);
  return row.publicId;
}

describe("buildHoldingRemovalProposal (#1106)", () => {
  test("a single asset baja → one line, negative delta (net worth falls)", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1")],
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.proposalType).toBe("holding_removal");
    expect(built.proposal.lines).toHaveLength(1);
    expect(built.proposal.lines[0]!.contributionMinor).toBe(2_500_00);
    expect(built.proposal.impact.deltaMinor).toBe(-2_500_00);
    expect(built.proposal.folio).toContain("papelera");
  });

  test("flags a debt orphaned by removing its associated asset (informative)", async () => {
    const store = await seed();
    await createCash(store, "a1", "Piso", 200_000_00);
    await store.liabilities.createLiability({
      associatedAssetId: "a1",
      balanceMinor: 120_000_00,
      currency: "EUR",
      id: "l1",
      name: "Hipoteca",
      ownership: SOLO,
      type: "mortgage",
    });
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1")],
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.orphanPairs).toEqual([
      { assetName: "Piso", debtName: "Hipoteca" },
    ]);
  });

  test("removing both the asset and its debt raises no orphan warning", async () => {
    const store = await seed();
    await createCash(store, "a1", "Piso", 200_000_00);
    await store.liabilities.createLiability({
      associatedAssetId: "a1",
      balanceMinor: 120_000_00,
      currency: "EUR",
      id: "l1",
      name: "Hipoteca",
      ownership: SOLO,
      type: "mortgage",
    });
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1"), await publicIdOf(store, "l1")],
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.orphanPairs).toEqual([]);
    expect(built.proposal.lines).toHaveLength(2);
  });

  test("marks a co-owned holding as shared ownership (informative)", async () => {
    const store = await seed([
      { id: "m", name: "Jose" },
      { id: "p", name: "Pareja" },
    ]);
    await createCash(store, "a1", "Cuenta conjunta", 10_000_00, [
      { memberId: "m", shareBps: 5_000 },
      { memberId: "p", shareBps: 5_000 },
    ]);
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1")],
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.lines[0]!.sharedOwnership).toBe(true);
    // Both owners are household members, so the household net worth still counts
    // the full value — shared ownership is an informative note, not a discount.
    expect(built.proposal.lines[0]!.contributionMinor).toBe(10_000_00);
  });

  test("an unknown / already-trashed id is a build error, not a warning", async () => {
    const store = await seed();
    const built = await buildHoldingRemovalProposal(store, ["wl_hld_ghost"], TODAY);
    expect(built.ok).toBe(false);
  });
});

describe("holding baja server action (#1106)", () => {
  test("confirm soft-deletes the whole batch atomically and marks it applied", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    await createCash(store, "a2", "Cuenta ING", 1_000_00);
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1"), await publicIdOf(store, "a2")],
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingRemovalProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    expect(await store.assets.readAssets()).toHaveLength(0);
    expect(await store.agentView.readTrashedHoldings()).toHaveLength(2);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
  });

  test("discard drops the batch with no writes", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    const built = await buildHoldingRemovalProposal(
      store,
      [await publicIdOf(store, "a1")],
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await discardHoldingRemovalProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "discarded" });
    expect(await store.assets.readAssets()).toHaveLength(1);
    expect(await store.agentView.readTrashedHoldings()).toHaveLength(0);
  });
});

describe("batchSoftDeleteHoldings atomicity (#1106)", () => {
  test("a target that no longer exists rolls the whole batch back", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);

    const result = await store.batchSoftDeleteHoldings(
      [
        { holdingId: "a1", kind: "asset" },
        { holdingId: "ghost", kind: "asset" },
      ],
      clock.now(),
    );

    expect(result).toEqual({ holdingId: "ghost", ok: false, reason: "not_found" });
    // Nothing persisted: a1 is still live, the trash is empty.
    expect(await store.assets.readAssets()).toHaveLength(1);
    expect(await store.agentView.readTrashedHoldings()).toHaveLength(0);
  });
});

describe("buildHoldingRestorationProposal (#1106)", () => {
  test("restores a trashed holding with a mirror line", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    const publicId = await publicIdOf(store, "a1");
    await store.assets.softDeleteAsset("a1", clock.now());

    const built = await buildHoldingRestorationProposal(store, [publicId], TODAY);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.proposalType).toBe("holding_restoration");
    expect(built.proposal.lines).toHaveLength(1);
    // Restoring an asset raises net worth by its contribution.
    expect(built.proposal.impact.deltaMinor).toBe(2_500_00);
    expect(built.proposal.duplicates).toEqual([]);
  });

  test("warns when a restored holding duplicates a live one (informative)", async () => {
    const store = await seed();
    await createCash(store, "live", "Cuenta BBVA", 3_000_00);
    await createCash(store, "trashed", "Cuenta BBVA", 2_500_00);
    const publicId = await publicIdOf(store, "trashed");
    await store.assets.softDeleteAsset("trashed", clock.now());

    const built = await buildHoldingRestorationProposal(store, [publicId], TODAY);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.duplicates).toEqual([
      { confidence: "weak", liveName: "Cuenta BBVA", name: "Cuenta BBVA" },
    ]);
  });

  test("restoring a holding that is NOT in the papelera is a validity error", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    const built = await buildHoldingRestorationProposal(
      store,
      [await publicIdOf(store, "a1")],
      TODAY,
    );
    expect(built.ok).toBe(false);
  });
});

describe("holding restauración server action (#1106)", () => {
  test("confirm restores the batch and marks it applied", async () => {
    const store = await seed();
    await createCash(store, "a1", "Cuenta BBVA", 2_500_00);
    const publicId = await publicIdOf(store, "a1");
    await store.assets.softDeleteAsset("a1", clock.now());
    const built = await buildHoldingRestorationProposal(store, [publicId], TODAY);
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingRestorationProposalAction(
      built.proposal.draft,
      store,
    );

    expect(result).toEqual({ status: "applied" });
    expect((await store.assets.readAssets()).map((asset) => asset.id)).toContain("a1");
    expect(await store.agentView.readTrashedHoldings()).toHaveLength(0);
  });
});

describe("batchRestoreHoldings atomicity (#1106)", () => {
  test("a not-in-trash target rolls the whole restore back (validity)", async () => {
    const store = await seed();
    await createCash(store, "trashed", "Cuenta BBVA", 2_500_00);
    await createCash(store, "live", "Cuenta ING", 1_000_00);
    await store.assets.softDeleteAsset("trashed", clock.now());

    const result = await store.batchRestoreHoldings([
      { holdingId: "trashed", kind: "asset" },
      { holdingId: "live", kind: "asset" },
    ]);

    expect(result).toEqual({ holdingId: "live", ok: false, reason: "not_in_trash" });
    // The trashed holding stays trashed — nothing half-restored.
    expect((await store.agentView.readTrashedHoldings()).map((h) => h.id)).toEqual([
      "trashed",
    ]);
  });
});
