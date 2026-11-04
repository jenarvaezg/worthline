/**
 * The inherited cost of a traspaso that came into a linked holding without it
 * (#1882, PRD #1876 S7): the one write a user makes on a holding its source owns.
 * One batch, one transaction, one ripple (ADR 0062); the answer survives the next
 * read of the same orders, because their dedup keys are already applied.
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import type { CreateInvestmentOperationInput, ManualAsset } from "@worthline/domain";
import { collectWarnings, derivePosition } from "@worthline/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const ripples = vi.hoisted(() => ({ assets: [] as string[][], calls: 0 }));

vi.mock("./ripple-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ripple-engine")>();
  return {
    ...original,
    rippleHistoricalSnapshotsForOperations: async (
      ...args: Parameters<typeof original.rippleHistoricalSnapshotsForOperations>
    ) => {
      ripples.calls += 1;
      ripples.assets.push(args[3].assets.map((side) => side.assetId).sort());
      return original.rippleHistoricalSnapshotsForOperations(...args);
    },
  };
});

const TODAY = "2026-11-04";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];

type Client = ReturnType<typeof openLibsqlClient>;
type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let client: Client;
let store: Store;
let sourceId: string;

/** The plan brought in from another institution: 40,237 units that were worth 701,33 €. */
const externalEntry: CreateInvestmentOperationInput = {
  assetId: "plan",
  currency: "EUR",
  executedAt: "2026-01-14",
  feesMinor: 0,
  id: "mi_entrada_externa",
  kind: "transfer_in",
  pricePerUnit: "17.43",
  source: "connected",
  transferCostMinor: 70_133,
  transferId: "myinvestor-external:r-ext",
  transferLegState: "cost_pending",
  units: "40.237",
};

/** 37 units bought at 23,17 € in the origin fund: 857,29 € of cost. */
const originBuy: CreateInvestmentOperationInput = {
  assetId: "origen",
  currency: "EUR",
  executedAt: "2025-03-04",
  feesMinor: 0,
  id: "mi_compra",
  kind: "buy",
  pricePerUnit: "23.17",
  source: "connected",
  units: "37",
};

/** The INTERNAL_TRANSFER_REIMBURSEMENT nobody paired: a sale until confirmed. */
const reimbursement: CreateInvestmentOperationInput = {
  assetId: "origen",
  currency: "EUR",
  executedAt: "2026-06-11",
  feesMinor: 0,
  id: "mi_reembolso",
  kind: "sell",
  pricePerUnit: "26.41",
  source: "connected",
  transferLegState: "unpaired_out",
  units: "37",
};

/** The INTERNAL_TRANSFER_SUBSCRIPTION five days later, cost pending. */
const internalEntry: CreateInvestmentOperationInput = {
  assetId: "destino",
  currency: "EUR",
  executedAt: "2026-06-16",
  feesMinor: 0,
  id: "mi_suscripcion",
  kind: "transfer_in",
  pricePerUnit: "23.5116",
  source: "connected",
  transferCostMinor: 97_103,
  transferId: "myinvestor-unpaired:r-in",
  transferLegState: "cost_pending",
  units: "41.3",
};

function holding(productKey: string, id: string, instrument: "fund" | "pension_plan") {
  return {
    holding: {
      asset: {
        currency: "EUR",
        id,
        instrument,
        liquidityTier: "market" as const,
        name: id,
        ownership: OWNER,
        securityId: { kind: "isin" as const, value: "IE00B03HD191" },
      },
      kind: "investment" as const,
    },
    productKey,
  };
}

function facts(operations: CreateInvestmentOperationInput[]) {
  return {
    cursor: TODAY,
    facts: operations.map((operation) => ({
      dateKey: operation.executedAt,
      key: `fact:${operation.id}`,
      payload: operation,
    })),
  };
}

async function includeAll(): Promise<void> {
  await store.command.includeConnectedHoldings({
    facts: facts([externalEntry, originBuy, reimbursement, internalEntry]),
    holdings: [
      holding("p-plan", "plan", "pension_plan"),
      holding("p-origen", "origen", "fund"),
      holding("p-destino", "destino", "fund"),
    ],
    sourceId,
    today: TODAY,
  });
  ripples.calls = 0;
  ripples.assets = [];
}

async function warningCodes(assetId: string): Promise<string[]> {
  const asset = (await store.assets.readAssets()).find((a) => a.id === assetId);
  const operations = await store.operations.readOperations(assetId);
  return collectWarnings([asset as ManualAsset], [], {
    operationsByAssetId: new Map([[assetId, operations]]),
  }).map((warning) => warning.code);
}

async function row(id: string) {
  const all = [
    ...(await store.operations.readOperations("plan")),
    ...(await store.operations.readOperations("origen")),
    ...(await store.operations.readOperations("destino")),
  ];
  return all.find((operation) => operation.id === id)!;
}

async function batchCount(): Promise<number> {
  return Number(
    (await client.execute("SELECT COUNT(*) AS n FROM fact_batch")).rows[0]!.n,
  );
}

beforeEach(async () => {
  ripples.calls = 0;
  ripples.assets = [];
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: "{}",
    label: "MyInvestor",
  });
  sourceId = connected!.sourceId;
  await includeAll();
});

describe("an external entry whose cost is pending", () => {
  test("raises the signal; answering it clears it and corrects the cost with one ripple", async () => {
    expect(await warningCodes("plan")).toContain("TRANSFER_COST_PENDING");
    const batchesBefore = await batchCount();

    const result = await store.command.resolveInheritedCost({
      assetId: "plan",
      costMinor: 61_177,
      entryOperationId: "mi_entrada_externa",
      kind: "declared",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true });
    expect(ripples.calls).toBe(1);
    expect(ripples.assets).toEqual([["plan"]]);
    expect(await batchCount()).toBe(batchesBefore + 1);
    expect(await row("mi_entrada_externa")).toMatchObject({
      transferCostMinor: 61_177,
      transferLegState: "cost_declared",
    });
    expect(await warningCodes("plan")).not.toContain("TRANSFER_COST_PENDING");
    // The holding is measured against the answered cost.
    const position = derivePosition(await store.operations.readOperations("plan"), {
      assetId: "plan",
      currency: "EUR",
    });
    expect(position.costBasis.amountMinor).toBe(61_177);
  });

  test("a later read of the same orders does not overwrite the answer", async () => {
    await store.command.resolveInheritedCost({
      assetId: "plan",
      costMinor: 61_177,
      entryOperationId: "mi_entrada_externa",
      kind: "declared",
      today: TODAY,
    });

    // The next read brings the same orders again (same dedup keys) and a new one
    // for a product included now: the port applies only what is new.
    const fresh: CreateInvestmentOperationInput = {
      ...originBuy,
      assetId: "nuevo",
      id: "mi_compra_nueva",
    };
    const applied = await store.command.includeConnectedHoldings({
      facts: facts([externalEntry, originBuy, reimbursement, internalEntry, fresh]),
      holdings: [holding("p-nuevo", "nuevo", "fund")],
      sourceId,
      today: TODAY,
    });

    expect(applied.applied).toBe(1);
    expect(await row("mi_entrada_externa")).toMatchObject({
      transferCostMinor: 61_177,
      transferLegState: "cost_declared",
    });
  });

  test("refuses a second answer, and a cost that is not positive", async () => {
    expect(
      await store.command.resolveInheritedCost({
        assetId: "plan",
        costMinor: 0,
        entryOperationId: "mi_entrada_externa",
        kind: "declared",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "cost_not_positive" });

    await store.command.resolveInheritedCost({
      assetId: "plan",
      costMinor: 61_177,
      entryOperationId: "mi_entrada_externa",
      kind: "declared",
      today: TODAY,
    });
    expect(
      await store.command.resolveInheritedCost({
        assetId: "plan",
        costMinor: 50_311,
        entryOperationId: "mi_entrada_externa",
        kind: "declared",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "not_pending" });
    expect(await row("mi_entrada_externa")).toMatchObject({ transferCostMinor: 61_177 });
  });

  test("is never paired with a reimbursement, even one the window would fit", async () => {
    // A reimbursement four days before, for almost what arrived: the rule's window
    // and tolerance fit, but an entry from another institution has its origin there.
    await store.command.includeConnectedHoldings({
      facts: facts([
        { ...originBuy, assetId: "otro", id: "mi_compra_otro", units: "26.57" },
        {
          ...reimbursement,
          assetId: "otro",
          executedAt: "2026-01-10",
          id: "mi_reembolso_otro",
          units: "26.57",
        },
      ]),
      holdings: [holding("p-otro", "otro", "fund")],
      sourceId,
      today: TODAY,
    });
    ripples.calls = 0;

    expect(
      await store.command.resolveInheritedCost({
        assetId: "plan",
        entryOperationId: "mi_entrada_externa",
        kind: "origin",
        originOperationId: "mi_reembolso_otro",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "not_a_candidate" });
    expect(ripples.calls).toBe(0);
    expect(await row("mi_entrada_externa")).toMatchObject({
      transferLegState: "cost_pending",
    });
  });

  test("refuses an entry that is not on the holding that asked", async () => {
    expect(
      await store.command.resolveInheritedCost({
        assetId: "destino",
        costMinor: 61_177,
        entryOperationId: "mi_entrada_externa",
        kind: "declared",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("an internal traspaso whose origin the user confirms", () => {
  test("the two legs become one traspaso: no realized gain, the cost travels, one ripple", async () => {
    const realizedBefore = derivePosition(
      await store.operations.readOperations("origen"),
      {
        assetId: "origen",
        currency: "EUR",
      },
    ).realizedPnl.amountMinor;
    expect(realizedBefore).toBe(97_717 - 85_729);
    expect(await store.operations.readUnpairedOutLegs(sourceId)).toHaveLength(1);

    const result = await store.command.resolveInheritedCost({
      assetId: "destino",
      entryOperationId: "mi_suscripcion",
      kind: "origin",
      originOperationId: "mi_reembolso",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true });
    expect(ripples.calls).toBe(1);
    expect(ripples.assets).toEqual([["destino", "origen"]]);
    expect(await row("mi_reembolso")).toMatchObject({
      kind: "transfer_out",
      transferId: "myinvestor-unpaired:r-in",
    });
    expect((await row("mi_reembolso")).transferLegState).toBeUndefined();
    expect(await row("mi_suscripcion")).toMatchObject({
      transferCostMinor: 85_729,
      transferId: "myinvestor-unpaired:r-in",
      transferLegState: "cost_from_origin",
    });
    expect(
      derivePosition(await store.operations.readOperations("origen"), {
        assetId: "origen",
        currency: "EUR",
      }).realizedPnl.amountMinor,
    ).toBe(0);
    expect(await store.operations.readUnpairedOutLegs(sourceId)).toEqual([]);
    expect(await warningCodes("destino")).not.toContain("TRANSFER_COST_PENDING");
  });

  test("an origin the rule would not propose is refused, and nothing moves", async () => {
    // The external plan entry is no reimbursement: it cannot be anyone's origin.
    expect(
      await store.command.resolveInheritedCost({
        assetId: "destino",
        entryOperationId: "mi_suscripcion",
        kind: "origin",
        originOperationId: "mi_entrada_externa",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "not_a_candidate" });
    expect(ripples.calls).toBe(0);
    expect(await row("mi_reembolso")).toMatchObject({
      kind: "sell",
      transferLegState: "unpaired_out",
    });
    expect(await row("mi_suscripcion")).toMatchObject({
      transferCostMinor: 97_103,
      transferLegState: "cost_pending",
    });
  });

  test("a reimbursement whose holding went to the Papelera is not an origin", async () => {
    await client.execute("UPDATE assets SET deleted_at = ? WHERE id = 'origen'", [
      "2026-11-03T10:00:00.000Z",
    ]);

    expect(
      await store.command.resolveInheritedCost({
        assetId: "destino",
        entryOperationId: "mi_suscripcion",
        kind: "origin",
        originOperationId: "mi_reembolso",
        today: TODAY,
      }),
    ).toEqual({ ok: false, reason: "not_a_candidate" });
  });

  test("saying «no, it came from elsewhere» and typing the cost leaves the sale a sale", async () => {
    const result = await store.command.resolveInheritedCost({
      assetId: "destino",
      costMinor: 90_011,
      entryOperationId: "mi_suscripcion",
      kind: "declared",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true });
    expect(await row("mi_reembolso")).toMatchObject({
      kind: "sell",
      transferLegState: "unpaired_out",
    });
    expect(await row("mi_suscripcion")).toMatchObject({
      transferCostMinor: 90_011,
      transferLegState: "cost_declared",
    });
  });
});
