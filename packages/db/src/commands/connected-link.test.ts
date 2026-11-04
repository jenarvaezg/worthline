/**
 * Linking a source that owns its holdings to holdings that already exist by hand
 * (#1881, ADR 0115 decisions 5 and 6): the source's operations replace the manual
 * ones in ONE fact_batch, ONE transaction and ONE ripple (ADR 0062), the replaced
 * rows stay as that batch's provenance, the holding's contribution plan closes today,
 * and disconnecting later freezes it with the source's operations.
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import {
  type CreateInvestmentOperationInput,
  projectContributionReconciliation,
} from "@worthline/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const ripples = vi.hoisted(() => ({
  calls: [] as { assetId: string; dates: string[] }[][],
}));

vi.mock("./ripple-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ripple-engine")>();
  return {
    ...original,
    rippleHistoricalSnapshotsForOperations: async (
      ...args: Parameters<typeof original.rippleHistoricalSnapshotsForOperations>
    ) => {
      ripples.calls.push(
        args[3].assets.map((asset) => ({
          assetId: asset.assetId,
          dates: [...asset.operationDateKeys].sort(),
        })),
      );
      return original.rippleHistoricalSnapshotsForOperations(...args);
    },
  };
});

const TODAY = "2026-11-04";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];
const ISIN = "IE00B03HD191";

type Client = ReturnType<typeof openLibsqlClient>;
type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let client: Client;
let store: Store;
let sourceId: string;

function buy(
  id: string,
  assetId: string,
  executedAt: string,
  source: "manual" | "connected",
  units = "3.0317",
): CreateInvestmentOperationInput {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "33.0731",
    source,
    units,
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

async function manualFund(id: string, isin: string | null = ISIN) {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id,
    instrument: "fund",
    liquidityTier: "market",
    name: `${id} (a mano)`,
    ownership: OWNER,
    ...(isin === null ? {} : { securityId: { kind: "isin" as const, value: isin } }),
  });
}

beforeEach(async () => {
  ripples.calls = [];
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
});

describe("linking a manual holding to an owning source", () => {
  test("the source's operations replace the manual ones in one batch and one ripple", async () => {
    await manualFund("hand");
    await store.operations.recordOperations([
      buy("m1", "hand", "2024-03-05", "manual"),
      buy("m2", "hand", "2024-09-06", "manual"),
    ]);

    const result = await store.command.includeConnectedHoldings({
      facts: facts([
        buy("s1", "hand", "2024-03-05", "connected"),
        buy("s2", "hand", "2024-09-05", "connected"),
        buy("s3", "new", "2025-02-11", "connected"),
      ]),
      holdings: [
        {
          holding: {
            asset: {
              currency: "EUR",
              id: "new",
              instrument: "fund",
              liquidityTier: "market",
              name: "Nuevo",
              ownership: OWNER,
            },
            kind: "investment",
          },
          productKey: "p-new",
        },
      ],
      links: [{ assetId: "hand", productKey: "p-hand" }],
      sourceId,
      today: TODAY,
    });

    expect(result).toEqual({ applied: 3, created: 1, linked: 1, portfolios: 0 });
    // ONE batch for the whole application, and ONE ripple whose floor reaches the
    // earliest of the replaced and the incoming dates.
    const batches = (await client.execute("SELECT id FROM fact_batch")).rows;
    expect(batches).toHaveLength(1);
    const batchId = batches[0]!.id;
    expect(ripples.calls).toHaveLength(1);
    expect(ripples.calls[0]).toEqual(
      expect.arrayContaining([
        {
          assetId: "hand",
          dates: ["2024-03-05", "2024-03-05", "2024-09-05", "2024-09-06"],
        },
      ]),
    );

    // The holding is the same one, now the source's, with only the source's rows.
    const operations = await store.operations.readOperations("hand");
    expect(operations.map((operation) => operation.id)).toEqual(["s1", "s2"]);
    const [asset] = (await store.assets.readAssets()).filter((row) => row.id === "hand");
    expect(asset?.connectedSourceId).toBe(sourceId);
    expect(asset?.name).toBe("hand (a mano)");
    expect(await store.connectedSources.readLinks(sourceId)).toEqual(
      expect.arrayContaining([{ assetId: "hand", productKey: "p-hand" }]),
    );

    // The replaced manual operations stay as the batch's provenance (ADR 0062).
    const replaced = await store.connectedSources.readReplacedOperations("hand");
    expect(replaced.map((row) => [row.batchId, row.operation.id])).toEqual([
      [batchId, "m1"],
      [batchId, "m2"],
    ]);
    expect(replaced[1]!.operation).toMatchObject({
      executedAt: "2024-09-06",
      kind: "buy",
      source: "manual",
      units: "3.0317",
    });
  });

  test("a holding without an identifier takes the product's on linking", async () => {
    await manualFund("named", null);

    await store.command.includeConnectedHoldings({
      facts: facts([buy("s1", "named", "2024-03-05", "connected")]),
      holdings: [],
      links: [
        {
          assetId: "named",
          productKey: "p-named",
          securityId: { kind: "isin", value: ISIN },
        },
      ],
      sourceId,
      today: TODAY,
    });

    const [asset] = (await store.assets.readAssets()).filter((row) => row.id === "named");
    expect(asset?.securityId).toEqual({ kind: "isin", value: ISIN });
  });

  test("its contribution plan closes today and its pending occurrences go", async () => {
    await manualFund("hand");
    await store.operations.recordOperations([buy("m1", "hand", "2026-07-05", "manual")]);
    const running = await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 10_037 },
      cadence: { dayOfMonth: 5, kind: "monthly" },
      destinationHoldingId: "hand",
      scopeId: "default",
      startDate: "2026-07-05",
    });
    const future = await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 5_013 },
      cadence: { kind: "quarterly" },
      destinationHoldingId: "hand",
      scopeId: "default",
      startDate: "2027-01-10",
    });
    await store.contributionPlan.linkOperation({
      contributionId: running.id,
      occurrenceId: `${running.id}:2026-07-05`,
      operationId: "m1",
    });

    await store.command.includeConnectedHoldings({
      facts: facts([buy("s1", "hand", "2026-07-06", "connected")]),
      holdings: [],
      links: [{ assetId: "hand", productKey: "p-hand" }],
      sourceId,
      today: TODAY,
    });

    const plan = await store.contributionPlan.readContributionPlan("default");
    expect(plan.contributions.map((line) => [line.id, line.endDate])).toEqual([
      [running.id, TODAY],
    ]);
    expect(plan.contributions.some((line) => line.id === future.id)).toBe(false);
    const projection = projectContributionReconciliation({
      fromDate: "2026-01-01",
      operations: [],
      plan,
      reconciliations: await store.contributionPlan.readReconciliations("default"),
      toDate: "2027-12-31",
      today: TODAY,
    });
    expect(projection.pending).toEqual([]);
  });

  test("disconnecting freezes it with the source's operations; the manual ones stay gone", async () => {
    await manualFund("hand");
    await store.operations.recordOperations([buy("m1", "hand", "2024-03-05", "manual")]);
    await store.command.includeConnectedHoldings({
      facts: facts([buy("s1", "hand", "2024-03-06", "connected")]),
      holdings: [],
      links: [{ assetId: "hand", productKey: "p-hand" }],
      sourceId,
      today: TODAY,
    });

    expect(await store.connectedSources.disconnectOwningSource(sourceId)).toEqual({
      frozen: 1,
    });

    const [asset] = (await store.assets.readAssets()).filter((row) => row.id === "hand");
    expect(asset?.connectedSourceId).toBeUndefined();
    expect(
      (await store.operations.readOperations("hand")).map((operation) => operation.id),
    ).toEqual(["s1"]);
    // Still the linking batch's provenance, even with the source gone.
    expect(
      (await store.connectedSources.readReplacedOperations("hand")).map(
        (row) => row.operation.id,
      ),
    ).toEqual(["m1"]);
  });

  test("refuses a holding that is not a live manual investment, and nothing lands", async () => {
    await manualFund("hand");
    await store.operations.recordOperations([buy("m1", "hand", "2024-03-05", "manual")]);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 12_345,
      id: "cash",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: OWNER,
      type: "cash",
    });

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([]),
        holdings: [],
        links: [{ assetId: "cash", productKey: "p-cash" }],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/manual investment/);
    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([]),
        holdings: [],
        links: [
          { assetId: "hand", productKey: "p1" },
          { assetId: "hand", productKey: "p2" },
        ],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/twice/);

    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(0);
    expect(
      (await store.operations.readOperations("hand")).map((operation) => operation.id),
    ).toEqual(["m1"]);
  });

  test("half a traspaso is never left behind: both holdings link together, or neither", async () => {
    await manualFund("origin", "ES0000000713");
    await manualFund("hand");
    await store.operations.recordOperations([
      buy("m0", "origin", "2024-01-09", "manual", "5.1173"),
      {
        ...buy("tout", "origin", "2024-05-14", "manual", "5.1173"),
        kind: "transfer_out",
        transferId: "t-hand",
      },
      {
        ...buy("tin", "hand", "2024-05-14", "manual", "4.7071"),
        kind: "transfer_in",
        transferCostMinor: 16_924,
        transferId: "t-hand",
      },
    ]);

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([]),
        holdings: [],
        links: [{ assetId: "hand", productKey: "p-hand" }],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/half a traspaso/);
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(0);

    await store.command.includeConnectedHoldings({
      facts: facts([]),
      holdings: [],
      links: [
        { assetId: "hand", productKey: "p-hand" },
        { assetId: "origin", productKey: "p-origin" },
      ],
      sourceId,
      today: TODAY,
    });
    expect(
      (
        await client.execute(
          "SELECT id FROM asset_operations WHERE transfer_id = 't-hand'",
        )
      ).rows,
    ).toEqual([]);
  });

  test("an already linked holding cannot be linked again", async () => {
    await manualFund("hand");
    await store.command.includeConnectedHoldings({
      facts: facts([]),
      holdings: [],
      links: [{ assetId: "hand", productKey: "p-hand" }],
      sourceId,
      today: TODAY,
    });

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([]),
        holdings: [],
        links: [{ assetId: "hand", productKey: "p-other" }],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/manual investment/);
  });

  test("an export carries the replaced operations back", async () => {
    await manualFund("hand");
    await store.operations.recordOperations([buy("m1", "hand", "2024-03-05", "manual")]);
    await store.command.includeConnectedHoldings({
      facts: facts([buy("s1", "hand", "2024-03-05", "connected")]),
      holdings: [],
      links: [{ assetId: "hand", productKey: "p-hand" }],
      sourceId,
      today: TODAY,
    });

    const doc = await store.workspace.exportWorkspace();
    const restored = await createStoreFromSqlite(openLibsqlClient(":memory:"));
    await restored.workspace.importWorkspace(doc);

    expect(
      (await restored.connectedSources.readReplacedOperations("hand")).map(
        (row) => row.operation.id,
      ),
    ).toEqual(["m1"]);
  });
});
