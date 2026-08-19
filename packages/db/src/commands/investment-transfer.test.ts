/**
 * The traspaso write gate (#1479, PRD #1393): the only path that mints — and the
 * only path that removes — the two halves of one traspaso.
 *
 * What this suite is for. The pair's whole promise is "both or neither", and that
 * promise cannot be tested against a pure plan: it is a property of the transaction.
 * So everything here drives `store.command.recordInvestmentTransfer` against a real
 * (in-memory) ledger and then asks the ledger what happened — including after a
 * write that fails halfway.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { derivePosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-08-19";
const DATE = "2026-07-31";

interface TransferOverrides {
  destinationAssetId?: string;
  destinationPricePerUnit?: string;
  executedAt?: string;
  feesMinor?: number;
  inOperationId?: string;
  originAssetId?: string;
  originPricePerUnit?: string;
  outOperationId?: string;
  portion?: { kind: "amount"; amountMinor: number } | { kind: "all" };
  transferId?: string;
}

function transferCommand(overrides: TransferOverrides = {}) {
  return {
    destinationAssetId: "destino",
    destinationPricePerUnit: "319.59",
    executedAt: DATE,
    inOperationId: "op_in",
    originAssetId: "origen",
    originPricePerUnit: "21.24",
    outOperationId: "op_out",
    portion: { amountMinor: 101_867, kind: "amount" as const },
    today: TODAY,
    transferId: "trf_1",
    ...overrides,
  };
}

/**
 * Jorge's real pair of funds: 47,96 participaciones of the origin bought at 15 €
 * (719,40 € of cost) and worth 21,24 € on the transfer date, plus an empty
 * destination.
 */
async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  for (const [id, name] of [
    ["origen", "Palm Harbour Global Value F EUR Acc"],
    ["destino", "Schroder ISF Global Gold A Acc EUR"],
  ] as const) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id,
      liquidityTier: "market",
      name,
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
  }
  await store.command.recordInvestmentOperation(
    {
      assetId: "origen",
      currency: "EUR",
      executedAt: "2024-03-01",
      feesMinor: 0,
      id: "op_compra",
      kind: "buy",
      pricePerUnit: "15",
      units: "47.96",
    },
    { today: TODAY },
  );
  return store;
}

async function positionOf(store: WorthlineStore, assetId: string) {
  return derivePosition(await store.operations.readOperations(assetId), {
    assetId,
    currency: "EUR",
  });
}

describe("recordInvestmentTransfer — one submit, one pair", () => {
  test("writes both halves tied by the same transferId, on the same date", async () => {
    const store = await seed();

    const result = await store.command.recordInvestmentTransfer(transferCommand());
    expect(result.ok).toBe(true);

    const [, out] = await store.operations.readOperations("origen");
    const [incoming] = await store.operations.readOperations("destino");

    expect(out).toMatchObject({
      executedAt: DATE,
      feesMinor: 0,
      kind: "transfer_out",
      transferId: "trf_1",
      units: "47.959981",
    });
    expect(incoming).toMatchObject({
      executedAt: DATE,
      kind: "transfer_in",
      transferId: "trf_1",
      units: "3.187428",
    });
  });

  test("the destination inherits the origin's cost — no realized gain, no reset basis", async () => {
    const store = await seed();
    await store.command.recordInvestmentTransfer(transferCommand());

    const origin = await positionOf(store, "origen");
    const destination = await positionOf(store, "destino");

    // The whole point of the instrument: 719,40 € of cost travels, and the 299,27 €
    // of latent gain travels with it instead of being realized.
    expect(destination.costBasis.amountMinor).toBe(71_940);
    expect(destination.realizedPnl.amountMinor).toBe(0);
    expect(origin.realizedPnl.amountMinor).toBe(0);
    expect(origin.costBasis.amountMinor).toBe(0);
  });

  test("«todo» empties the origin — no residual participaciones", async () => {
    const store = await seed();

    const result = await store.command.recordInvestmentTransfer(
      transferCommand({ portion: { kind: "all" } }),
    );
    expect(result.ok).toBe(true);

    expect((await positionOf(store, "origen")).currentUnits).toBe("0");
    expect((await positionOf(store, "destino")).costBasis.amountMinor).toBe(71_940);
  });

  test("the VLs come from the caller, and the units are derived from them", async () => {
    const store = await seed();
    // A partial traspaso of 509,33 €: half the position leaves, half the cost with it.
    await store.command.recordInvestmentTransfer(
      transferCommand({ portion: { amountMinor: 50_933, kind: "amount" } }),
    );

    const origin = await positionOf(store, "origen");
    expect(origin.currentUnits).toBe("23.980245");
    expect(origin.costBasis.amountMinor).toBe(35_970);
    expect((await positionOf(store, "destino")).costBasis.amountMinor).toBe(35_970);
  });

  test("the pair ripples BOTH holdings' history from the transfer date", async () => {
    const store = await seed();
    await store.command.recordInvestmentTransfer(transferCommand());

    // A snapshot is generated at the backdated date (ADR 0012) and BOTH holdings are
    // frozen into it: the destination exists on the 31st instead of appearing weeks
    // later, which is the 17-day hole of #1393 closing.
    expect(
      (await store.snapshots.readSnapshots()).some((snap) => snap.dateKey === DATE),
    ).toBe(true);
    const holdings = await store.snapshots.readSnapshotHoldings({ from: DATE, to: DATE });
    const held = new Map(holdings.map((row) => [row.holdingId, row.units]));
    expect(held.get("origen")).toBe("0.000019");
    expect(held.get("destino")).toBe("3.187428");
  });
});

describe("recordInvestmentTransfer — both or neither", () => {
  test("a half that collides on its id leaves NOTHING behind", async () => {
    const store = await seed();
    // The incoming half's id is already taken, so its INSERT fails after the
    // outgoing half is already written — the exact mid-flight failure the gate
    // exists for. `op_compra` is on the ORIGIN, so nothing about the destination
    // could have refused this before the write.
    await expect(
      store.command.recordInvestmentTransfer(
        transferCommand({ inOperationId: "op_compra" }),
      ),
    ).rejects.toThrow();

    // The origin still holds its whole position: no orphan transfer_out.
    expect(
      (await store.operations.readOperations("origen")).map((op) => op.kind),
    ).toEqual(["buy"]);
    expect(await store.operations.readOperations("destino")).toEqual([]);
  });

  test("nothing is written when the amount exceeds the position", async () => {
    const store = await seed();

    const result = await store.command.recordInvestmentTransfer(
      transferCommand({ portion: { amountMinor: 200_000, kind: "amount" } }),
    );

    expect(result).toEqual({
      ok: false,
      violations: [
        {
          code: "transfer_units_exceed_position",
          unitsHeld: "47.96",
          unitsRequested: "94.161959",
        },
      ],
    });
    expect((await store.operations.readOperations("origen")).length).toBe(1);
    expect(await store.operations.readOperations("destino")).toEqual([]);
  });

  test("a second traspaso the SAME day sees the origin the first one already reduced", async () => {
    const store = await seed();
    await store.command.recordInvestmentTransfer(
      transferCommand({ portion: { amountMinor: 50_933, kind: "amount" } }),
    );

    // 23,979755 part. left in the first one, so ~23,98 remain. Asking for the same
    // amount again is fine; asking for the ORIGINAL whole position is not — the fold
    // includes the same day's earlier half (`operationsUpTo` is inclusive), so the
    // second one cannot spend units the first already moved.
    expect(
      (
        await store.command.recordInvestmentTransfer(
          transferCommand({
            inOperationId: "op_in_2",
            outOperationId: "op_out_2",
            portion: { amountMinor: 101_867, kind: "amount" },
            transferId: "trf_2",
          }),
        )
      ).ok,
    ).toBe(false);

    const second = await store.command.recordInvestmentTransfer(
      transferCommand({
        inOperationId: "op_in_2",
        outOperationId: "op_out_2",
        portion: { kind: "all" },
        transferId: "trf_2",
      }),
    );
    expect(second.ok).toBe(true);
    expect((await positionOf(store, "origen")).currentUnits).toBe("0");
    // Both slices of cost arrive: 359,70 € + 359,70 €, the whole 719,40 €.
    expect((await positionOf(store, "destino")).costBasis.amountMinor).toBe(71_940);
  });

  test("the position is folded at the TRANSFER date, not today", async () => {
    const store = await seed();
    // Bought again AFTER the traspaso date: those units did not exist on the 31st,
    // so they neither back the amount nor lend their cost to the destination.
    await store.command.recordInvestmentOperation(
      {
        assetId: "origen",
        currency: "EUR",
        executedAt: "2026-08-10",
        feesMinor: 0,
        id: "op_compra_2",
        kind: "buy",
        pricePerUnit: "21",
        units: "100",
      },
      { today: TODAY },
    );

    const result = await store.command.recordInvestmentTransfer(
      transferCommand({ portion: { amountMinor: 200_000, kind: "amount" } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("recordInvestmentTransfer — the hostile inputs", () => {
  test("a destination that is not in this workspace's book is refused loudly", async () => {
    const store = await seed();

    // The database is per-workspace (ADR 0030), so a holding from another workspace
    // is simply a holding this book has never heard of. It throws rather than
    // becoming a field error: the screen picks the destination from a list of THIS
    // workspace's holdings, so an unknown id is a bug or an attack, not a typo.
    await expect(
      store.command.recordInvestmentTransfer(
        transferCommand({ destinationAssetId: "de_otro_workspace" }),
      ),
    ).rejects.toThrow(/de_otro_workspace/);

    expect((await store.operations.readOperations("origen")).length).toBe(1);
  });

  test("a holding that is not an investment cannot be either half", async () => {
    const store = await seed();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 500_000,
      id: "cuenta",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    // A traspaso moves participaciones between products that HAVE participaciones.
    // A current account has none, and an operation against it would hand it a
    // derived value it is not valued by (ADR 0006).
    await expect(
      store.command.recordInvestmentTransfer(
        transferCommand({ destinationAssetId: "cuenta" }),
      ),
    ).rejects.toThrow(/cuenta/);
  });

  test("two investments in different currencies cannot be paired", async () => {
    const store = await seed();
    await store.assets.createInvestmentAsset({
      currency: "USD",
      id: "destino_usd",
      liquidityTier: "market",
      name: "Fondo en dólares",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    // The inherited cost is an amount in the origin's currency written onto the
    // destination's row. Crossing currencies would need a rate nobody stated, and
    // the ledger sums ONE currency per holding (#1401).
    expect(
      await store.command.recordInvestmentTransfer(
        transferCommand({ destinationAssetId: "destino_usd" }),
      ),
    ).toEqual({
      ok: false,
      violations: [
        { code: "transfer_currency_mismatch", destination: "USD", origin: "EUR" },
      ],
    });
  });

  test("a holding cannot be traspasado to itself", async () => {
    const store = await seed();

    expect(
      await store.command.recordInvestmentTransfer(
        transferCommand({ destinationAssetId: "origen" }),
      ),
    ).toEqual({ ok: false, violations: [{ code: "transfer_same_holding" }] });
  });

  test("a VL of zero is refused before anything is read", async () => {
    const store = await seed();

    expect(
      await store.command.recordInvestmentTransfer(
        transferCommand({ destinationPricePerUnit: "0" }),
      ),
    ).toEqual({
      ok: false,
      violations: [{ code: "transfer_price_not_positive", side: "destination" }],
    });
  });
});

describe("recordExternalTransferIn — the half that has no pair", () => {
  test("writes one transfer_in and ripples only the destination", async () => {
    const store = await seed();

    const result = await store.command.recordExternalTransferIn({
      amountMinor: 9_546,
      destinationAssetId: "destino",
      destinationPricePerUnit: "12.5",
      executedAt: "2026-01-23",
      inOperationId: "op_ext",
      today: TODAY,
      transferId: "trf_ext",
    });
    expect(result.ok).toBe(true);

    // Jorge's real 23-ene «Alta por traspaso externo»: the outgoing half lives in
    // another institution, so there is nothing here to pair it with.
    const [incoming] = await store.operations.readOperations("destino");
    expect(incoming).toMatchObject({
      kind: "transfer_in",
      transferCostMinor: 9_546,
      transferId: "trf_ext",
      units: "7.6368",
    });
    // The origin's ledger is untouched: this traspaso did not come from it.
    expect((await store.operations.readOperations("origen")).length).toBe(1);
    expect(
      (await store.snapshots.readSnapshots()).some(
        (snap) => snap.dateKey === "2026-01-23",
      ),
    ).toBe(true);
  });

  test("the declared inherited cost is what the position folds, not the amount", async () => {
    const store = await seed();
    await store.command.recordExternalTransferIn({
      amountMinor: 9_546,
      destinationAssetId: "destino",
      destinationPricePerUnit: "12.5",
      executedAt: "2026-01-23",
      inOperationId: "op_ext",
      inheritedCostMinor: 7_000,
      today: TODAY,
      transferId: "trf_ext",
    });

    const position = await positionOf(store, "destino");
    expect(position.costBasis.amountMinor).toBe(7_000);
    // And it realizes nothing: an entry is not a gain.
    expect(position.realizedPnl.amountMinor).toBe(0);
  });

  test("it is deleted through the same pair gate, by its own transferId", async () => {
    const store = await seed();
    await store.command.recordExternalTransferIn({
      amountMinor: 9_546,
      destinationAssetId: "destino",
      destinationPricePerUnit: "12.5",
      executedAt: "2026-01-23",
      inOperationId: "op_ext",
      today: TODAY,
      transferId: "trf_ext",
    });

    // The pair delete removes whatever carries the id — one row here, two for a real
    // pair. A reader that pairs by `transferId` and finds one is looking at this.
    const deleted = await store.command.deleteInvestmentTransfer({
      today: TODAY,
      transferId: "trf_ext",
    });
    expect(deleted.map((row) => row.assetId)).toEqual(["destino"]);
    expect(await store.operations.readOperations("destino")).toEqual([]);
  });
});

describe("deleteInvestmentTransfer — the pair leaves together too", () => {
  test("deleting the traspaso removes both halves and ripples both holdings", async () => {
    const store = await seed();
    await store.command.recordInvestmentTransfer(transferCommand());

    const deleted = await store.command.deleteInvestmentTransfer({
      today: TODAY,
      transferId: "trf_1",
    });

    expect(deleted?.map((row) => row.assetId).sort()).toEqual(["destino", "origen"]);
    expect(
      (await store.operations.readOperations("origen")).map((op) => op.kind),
    ).toEqual(["buy"]);
    expect(await store.operations.readOperations("destino")).toEqual([]);
    // The origin is whole again — the deletion is a true undo of the pair.
    expect((await positionOf(store, "origen")).currentUnits).toBe("47.96");
  });

  test("an unknown transferId deletes nothing", async () => {
    const store = await seed();

    expect(
      await store.command.deleteInvestmentTransfer({
        today: TODAY,
        transferId: "trf_inexistente",
      }),
    ).toEqual([]);
  });

  test("half a traspaso cannot be deleted through the single-operation path", async () => {
    const store = await seed();
    await store.command.recordInvestmentTransfer(transferCommand());

    // The row-at-a-time delete is what the operations table's button calls. Letting
    // it through would leave the other half in the book claiming to be one move with
    // a row that no longer exists — and, on the destination, an inherited cost with
    // nothing that explains it.
    await expect(
      store.command.deleteInvestmentOperation({ operationId: "op_out", today: TODAY }),
    ).rejects.toThrow(/Half a traspaso cannot be deleted on its own/);

    expect((await store.operations.readOperations("origen")).length).toBe(2);
  });
});
