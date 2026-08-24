/**
 * The Papelera's gate, against a real database (#1549, ADR 0085).
 *
 * The case this exists for is Groupama (#1365): a fund with 7.642 € inside went to
 * the trash, its value left the patrimonio at the next capture, and the histórico
 * recorded no sale, no traspaso and no deposit anywhere. What is pinned here is that
 * the gate lives at the STORE seam — so the ficha, the assistant's batch and any
 * future writer meet the same refusal — and that each of the three exits leaves the
 * book in an honest state.
 */

import type { PersistenceTestStore as WorthlineStore } from "@db/testing";
import { createInMemoryStore } from "@db/testing";
import { derivePosition } from "@worthline/domain";
import { beforeEach, describe, expect, test } from "vitest";

const TODAY = "2026-08-23";
const NOW = `${TODAY}T10:00:00.000Z`;

let store: WorthlineStore;

/** A workspace with one fund holding 100 participaciones bought at 60 €. */
async function seedFund(): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "a_groupama",
    instrument: "fund",
    name: "Groupama Trésorerie",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
  });
  await store.operations.recordOperation({
    assetId: "a_groupama",
    currency: "EUR",
    executedAt: "2026-01-15",
    id: "op_buy",
    kind: "buy",
    pricePerUnit: "60",
    units: "100",
  });
}

async function positionOf(assetId: string) {
  return derivePosition(await store.operations.readOperations(assetId), {
    assetId,
    currency: "EUR",
  });
}

beforeEach(async () => {
  store = await createInMemoryStore();
});

describe("softDeleteAsset — money inside cannot leave in silence", () => {
  test("a holding with units is refused, and the refusal names them", async () => {
    await seedFund();

    const outcome = await store.assets.softDeleteAsset("a_groupama", NOW);

    expect(outcome).toEqual({
      refusal: { netUnits: "100", reason: "needs_exit" },
      status: "refused",
    });
    // Refused means NOTHING was written: the holding is still live.
    expect((await store.assets.readAssets()).map((a) => a.id)).toEqual(["a_groupama"]);
  });

  test("«lo vendí» and «lo traspasé» are not keys — they unlock nothing on their own", async () => {
    await seedFund();

    for (const exit of ["sold", "transferred"] as const) {
      const outcome = await store.assets.softDeleteAsset("a_groupama", NOW, exit);
      expect(outcome.status).toBe("refused");
    }
  });

  test("«error de registro» archives it, and the row remembers the declaration", async () => {
    await seedFund();

    expect(await store.assets.softDeleteAsset("a_groupama", NOW, "mis_entry")).toEqual({
      status: "deleted",
    });

    const trashed = await store.agentView.readTrashedHoldings();
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatchObject({ id: "a_groupama", trashExit: "mis_entry" });
  });

  test("restoring the holding takes the declaration with it", async () => {
    await seedFund();
    await store.assets.softDeleteAsset("a_groupama", NOW, "mis_entry");

    expect(await store.assets.restoreAsset("a_groupama")).toBe(1);
    expect(await store.agentView.readTrashedHoldings()).toEqual([]);

    // The declaration was spent on the deletion it explained: the next trash has to
    // answer the question again rather than inherit yesterday's answer.
    expect((await store.assets.softDeleteAsset("a_groupama", NOW)).status).toBe(
      "refused",
    );
  });

  test("a sold-out position needs no exit — the clean delete stays clean", async () => {
    await seedFund();
    await store.operations.recordOperation({
      assetId: "a_groupama",
      currency: "EUR",
      executedAt: "2026-07-01",
      id: "op_sell",
      kind: "sell",
      pricePerUnit: "76.42",
      units: "100",
    });

    expect(await store.assets.softDeleteAsset("a_groupama", NOW)).toEqual({
      status: "deleted",
    });
    const trashed = await store.agentView.readTrashedHoldings();
    expect(trashed[0]).toMatchObject({ trashExit: null });
  });

  test("a holding that never existed is not found, which is not the same as refused", async () => {
    await seedFund();

    expect(await store.assets.softDeleteAsset("a_ghost", NOW)).toEqual({
      status: "not_found",
    });
  });

  test("a cash account with no ledger keeps its silent, reversible delete", async () => {
    await seedFund();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "a_cash",
      liquidityTier: "cash",
      name: "Cuenta ING",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });

    expect(await store.assets.softDeleteAsset("a_cash", NOW)).toEqual({
      status: "deleted",
    });
  });
});

describe("softDeleteAsset — the Groupama regression (#1365 → #1549)", () => {
  test("traspasado to another fund: the patrimonio keeps the money and the cost travels", async () => {
    await seedFund();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "a_destino",
      instrument: "fund",
      name: "Indexa RV Global",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });

    const before = await positionOf("a_groupama");
    expect(before.costBasis.amountMinor).toBe(6_000_00);

    const result = await store.command.recordInvestmentTransfer({
      destinationAssetId: "a_destino",
      destinationPricePerUnit: "80",
      executedAt: "2026-08-01",
      inOperationId: "op_in",
      originAssetId: "a_groupama",
      originPricePerUnit: "76.42",
      outOperationId: "op_out",
      portion: { kind: "all" },
      today: TODAY,
      transferId: "trf_1",
    });
    expect(result.ok).toBe(true);

    // The origin is empty, so the door opens with no exit to declare — and the
    // exit is recorded anyway, because the traspaso is what emptied it.
    expect(await store.assets.softDeleteAsset("a_groupama", NOW, "transferred")).toEqual({
      status: "deleted",
    });

    const origin = await positionOf("a_groupama");
    const destination = await positionOf("a_destino");
    expect(origin.currentUnits).toBe("0");
    // 7.642 € of market value at the transfer's VL, arriving at 80 € the unit.
    expect(destination.currentUnits).toBe("95.525");
    // ADR 0082: the acquisition cost travels on the row. Nothing is realized, so
    // the patrimonio's cost basis is exactly the one that left.
    expect(destination.costBasis.amountMinor).toBe(before.costBasis.amountMinor);
  });
});

describe("softDeleteAsset — a managed portfolio's cash box (ADR 0085)", () => {
  async function seedPortfolio(): Promise<string> {
    await seedFund();
    const portfolio = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: "m1", shareBps: 10_000 }],
      memberHoldingIds: [],
      name: "Cartera Indexada Metal",
      scopeId: "m1",
    });
    const cashId = portfolio.holdingIds[0];
    expect(cashId).toBeDefined();
    return cashId as string;
  }

  test("cannot be trashed while the cartera lives, with or without an exit", async () => {
    const cashId = await seedPortfolio();

    for (const exit of [null, "mis_entry"] as const) {
      expect(await store.assets.softDeleteAsset(cashId, NOW, exit)).toEqual({
        refusal: { portfolioName: "Cartera Indexada Metal", reason: "portfolio_cash" },
        status: "refused",
      });
    }
  });

  test("once the cartera is gone it is an ordinary account again", async () => {
    const cashId = await seedPortfolio();
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios();
    await store.managedPortfolios.deleteManagedPortfolio(portfolio!.id);

    expect(await store.assets.softDeleteAsset(cashId, NOW)).toEqual({
      status: "deleted",
    });
  });
});

describe("batchSoftDeleteHoldings — the assistant meets the same gate (#1468)", () => {
  test("a fund with units aborts the whole batch, and nothing is archived", async () => {
    await seedFund();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "a_cash",
      liquidityTier: "cash",
      name: "Cuenta ING",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });

    const result = await store.batchSoftDeleteHoldings(
      [
        { holdingId: "a_cash", kind: "asset" },
        { holdingId: "a_groupama", kind: "asset" },
      ],
      NOW,
    );

    expect(result).toEqual({
      holdingId: "a_groupama",
      ok: false,
      reason: "needs_exit",
    });
    expect(await store.agentView.readTrashedHoldings()).toEqual([]);
  });
});
