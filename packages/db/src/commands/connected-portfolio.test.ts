/**
 * A robo-advisor's account as a managed portfolio (#1883, ADR 0085 as amended): the
 * source brings the whole block — funds, cash sibling and the manager's declared
 * balance as witness — or takes over a portfolio kept by hand, WHOLE, in the same
 * batch that writes its history (ADR 0062).
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import type {
  CreateInvestmentOperationInput,
  ManagedPortfolioWitness,
} from "@worthline/domain";
import { beforeEach, describe, expect, test } from "vitest";

const TODAY = "2026-11-04";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];
const GOLD = "IE00B03HD191";
const SILVER = "IE00BYX5NX33";
const WITNESS: ManagedPortfolioWitness = {
  declaredDate: TODAY,
  declaredValue: { amountMinor: 61_237, currency: "EUR" },
};

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
): CreateInvestmentOperationInput {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "27.4113",
    source,
    units: "4.0219",
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

function fund(productKey: string, id: string, isin: string) {
  return {
    holding: {
      asset: {
        currency: "EUR",
        id,
        instrument: "fund" as const,
        liquidityTier: "market" as const,
        name: id,
        ownership: OWNER,
        securityId: { kind: "isin" as const, value: isin },
      },
      kind: "investment" as const,
    },
    productKey,
  };
}

function cash(productKey: string, id: string, balanceMinor: number) {
  return {
    holding: {
      asset: {
        currency: "EUR",
        currentValueMinor: balanceMinor,
        id,
        instrument: "current_account" as const,
        liquidityTier: "cash" as const,
        name: id,
        ownership: OWNER,
        type: "cash" as const,
      },
      kind: "cash" as const,
    },
    productKey,
  };
}

async function asset(id: string) {
  return (await store.assets.readAssets()).find((row) => row.id === id);
}

beforeEach(async () => {
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

describe("a robo-advisor brought whole", () => {
  test("its funds, its cash sibling and its witness land as one portfolio, in one batch", async () => {
    const result = await store.command.includeConnectedHoldings({
      facts: facts([
        buy("o1", "gold", "2025-02-11", "connected"),
        buy("o2", "silver", "2025-02-11", "connected"),
      ]),
      holdings: [
        fund("acc|isin:gold", "gold", GOLD),
        fund("acc|isin:silver", "silver", SILVER),
        cash("cash:7", "box", 734),
      ],
      portfolios: [
        {
          memberAssetIds: ["gold", "silver", "box"],
          name: "Cartera sintética",
          productKey: "portfolio:7",
          provider: "MyInvestor",
          scopeId: "m",
          witness: WITNESS,
        },
      ],
      sourceId,
      today: TODAY,
    });

    expect(result).toEqual({ applied: 2, created: 3, linked: 0, portfolios: 1 });
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(1);
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios();
    expect(portfolio).toMatchObject({
      holdingIds: ["box", "gold", "silver"],
      name: "Cartera sintética",
      provider: "MyInvestor",
      scopeId: "m",
      witness: WITNESS,
    });
    // The cash sibling is the source's own cash account, not a 0 € box of the alta.
    expect(await store.managedPortfolios.readCashContainerName("box")).toBe(
      "Cartera sintética",
    );
    expect((await asset("box"))?.currentValue.amountMinor).toBe(734);
    expect((await asset("gold"))?.connectedSourceId).toBe(sourceId);
  });

  test("a member the batch does not create is refused, and nothing lands", async () => {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand",
      instrument: "fund",
      liquidityTier: "market",
      name: "A mano",
      ownership: OWNER,
    });

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([buy("o1", "gold", "2025-02-11", "connected")]),
        holdings: [fund("acc|isin:gold", "gold", GOLD)],
        portfolios: [
          {
            memberAssetIds: ["gold", "hand"],
            name: "Cartera sintética",
            productKey: "portfolio:7",
            provider: "MyInvestor",
            scopeId: "m",
            witness: null,
          },
        ],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/does not create/);
    expect(await store.managedPortfolios.readManagedPortfolios()).toEqual([]);
    expect(await asset("gold")).toBeUndefined();
  });

  test("a fund the manager buys later joins it, and each sync refreshes the witness", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "gold", "2025-02-11", "connected")]),
      holdings: [fund("acc|isin:gold", "gold", GOLD), cash("cash:7", "box", 734)],
      portfolios: [
        {
          memberAssetIds: ["gold", "box"],
          name: "Cartera sintética",
          productKey: "portfolio:7",
          provider: "MyInvestor",
          scopeId: "m",
          witness: WITNESS,
        },
      ],
      sourceId,
      today: TODAY,
    });
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios();

    // Its members are already the source's: taking the new fund in is no takeover.
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o2", "silver", "2026-10-07", "connected")]),
      holdings: [fund("acc|isin:silver", "silver", SILVER)],
      portfolioLinks: [
        {
          addMemberAssetIds: ["silver"],
          portfolioId: portfolio!.id,
          productKey: "portfolio:7",
          witness: null,
        },
      ],
      sourceId,
      today: TODAY,
    });
    const refreshed: ManagedPortfolioWitness = {
      declaredDate: "2026-11-05",
      declaredValue: { amountMinor: 72_119, currency: "EUR" },
    };
    await store.command.syncConnectedHoldings({
      cashBalances: [],
      facts: facts([]),
      portfolioWitnesses: [{ assetId: "gold", witness: refreshed }],
      sourceId,
      today: "2026-11-05",
    });

    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after).toMatchObject({
      holdingIds: ["box", "gold", "silver"],
      witness: refreshed,
    });
  });

  test("editing its name keeps the members the source owns", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "gold", "2025-02-11", "connected")]),
      holdings: [fund("acc|isin:gold", "gold", GOLD), cash("cash:7", "box", 734)],
      portfolios: [
        {
          memberAssetIds: ["gold", "box"],
          name: "Cartera sintética",
          productKey: "portfolio:7",
          provider: "MyInvestor",
          scopeId: "m",
          witness: null,
        },
      ],
      sourceId,
      today: TODAY,
    });
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios();

    // The form never offers a source's member as a chip, so it never posts it.
    await store.managedPortfolios.updateManagedPortfolio(portfolio!.id, {
      memberHoldingIds: [],
      name: "Metal",
    });

    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after).toMatchObject({ holdingIds: ["box", "gold"], name: "Metal" });
  });
});

describe("a portfolio kept by hand, taken over as a block", () => {
  async function manualPortfolio(): Promise<{ id: string; cashId: string }> {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand-gold",
      instrument: "fund",
      liquidityTier: "market",
      name: "Oro (a mano)",
      ownership: OWNER,
      securityId: { kind: "isin", value: GOLD },
    });
    await store.operations.recordOperations([
      buy("m1", "hand-gold", "2025-02-12", "manual"),
    ]);
    const portfolio = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: OWNER,
      memberHoldingIds: ["hand-gold"],
      name: "Metal a mano",
      scopeId: "m",
    });
    const cashId = portfolio.holdingIds.find((id) => id !== "hand-gold")!;
    return { cashId, id: portfolio.id };
  }

  test("its members, its cash and the funds it lacked become the source's at once", async () => {
    const portfolio = await manualPortfolio();

    const result = await store.command.includeConnectedHoldings({
      cashLinks: [{ assetId: portfolio.cashId, balanceMinor: 913, productKey: "cash:7" }],
      facts: facts([
        buy("o1", "hand-gold", "2025-02-11", "connected"),
        buy("o2", "silver", "2025-02-11", "connected"),
      ]),
      holdings: [fund("acc|isin:silver", "silver", SILVER)],
      links: [{ assetId: "hand-gold", productKey: "acc|isin:gold" }],
      portfolioLinks: [
        {
          addMemberAssetIds: ["silver"],
          portfolioId: portfolio.id,
          productKey: "portfolio:7",
          witness: WITNESS,
        },
      ],
      sourceId,
      today: TODAY,
    });

    expect(result).toEqual({ applied: 2, created: 1, linked: 1, portfolios: 1 });
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(1);
    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after).toMatchObject({
      holdingIds: [portfolio.cashId, "hand-gold", "silver"].sort(),
      name: "Metal a mano",
      witness: WITNESS,
    });
    const box = await asset(portfolio.cashId);
    expect(box?.connectedSourceId).toBe(sourceId);
    expect(box?.currentValue.amountMinor).toBe(913);
    const operations = await store.operations.readOperations("hand-gold");
    expect(operations.map((operation) => operation.id)).toEqual(["o1"]);
    expect(await store.connectedSources.readLinks(sourceId)).toEqual(
      expect.arrayContaining([
        { assetId: portfolio.cashId, productKey: "cash:7" },
        { assetId: "hand-gold", productKey: "acc|isin:gold" },
        { assetId: "silver", productKey: "acc|isin:silver" },
      ]),
    );
  });

  test("a member left manual blocks the whole link, and nothing changes", async () => {
    const portfolio = await manualPortfolio();

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([buy("o2", "silver", "2025-02-11", "connected")]),
        holdings: [fund("acc|isin:silver", "silver", SILVER)],
        cashLinks: [
          { assetId: portfolio.cashId, balanceMinor: 913, productKey: "cash:7" },
        ],
        portfolioLinks: [
          {
            addMemberAssetIds: ["silver"],
            portfolioId: portfolio.id,
            productKey: "portfolio:7",
            witness: WITNESS,
          },
        ],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/linked whole/);

    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after?.holdingIds).toEqual([portfolio.cashId, "hand-gold"].sort());
    expect(after?.witness).toBeNull();
    expect((await asset(portfolio.cashId))?.connectedSourceId ?? null).toBeNull();
    expect(await store.connectedSources.readLinks(sourceId)).toEqual([]);
  });

  test("with no cash account at the source, the cash box stays the owner's", async () => {
    const portfolio = await manualPortfolio();

    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "hand-gold", "2025-02-11", "connected")]),
      holdings: [],
      links: [{ assetId: "hand-gold", productKey: "acc|isin:gold" }],
      portfolioLinks: [
        {
          addMemberAssetIds: [],
          portfolioId: portfolio.id,
          productKey: "portfolio:7",
          witness: null,
        },
      ],
      sourceId,
      today: TODAY,
    });

    expect((await asset(portfolio.cashId))?.connectedSourceId ?? null).toBeNull();
    expect((await asset("hand-gold"))?.connectedSourceId).toBe(sourceId);
  });

  test("one member of it is never linked on its own", async () => {
    await manualPortfolio();

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([buy("o1", "hand-gold", "2025-02-11", "connected")]),
        holdings: [],
        links: [{ assetId: "hand-gold", productKey: "acc|isin:gold" }],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/whole portfolio/);
    expect((await asset("hand-gold"))?.connectedSourceId ?? null).toBeNull();
  });

  test("a member in the Papelera leaves the group the source takes over", async () => {
    const portfolio = await manualPortfolio();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand-old",
      instrument: "fund",
      liquidityTier: "market",
      name: "Viejo (a mano)",
      ownership: OWNER,
    });
    await store.managedPortfolios.updateManagedPortfolio(portfolio.id, {
      memberHoldingIds: ["hand-gold", "hand-old"],
    });
    await client.execute({
      args: ["hand-old"],
      sql: "UPDATE assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
    });

    await store.command.includeConnectedHoldings({
      cashLinks: [{ assetId: portfolio.cashId, balanceMinor: 913, productKey: "cash:7" }],
      facts: facts([buy("o1", "hand-gold", "2025-02-11", "connected")]),
      holdings: [],
      links: [{ assetId: "hand-gold", productKey: "acc|isin:gold" }],
      portfolioLinks: [
        {
          addMemberAssetIds: [],
          portfolioId: portfolio.id,
          productKey: "portfolio:7",
          witness: null,
        },
      ],
      sourceId,
      today: TODAY,
    });

    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after!.holdingIds).toEqual([portfolio.cashId, "hand-gold"].sort());
  });

  test("once the source's, it takes no hand-made member", async () => {
    const portfolio = await manualPortfolio();
    await store.command.includeConnectedHoldings({
      cashLinks: [{ assetId: portfolio.cashId, balanceMinor: 913, productKey: "cash:7" }],
      facts: facts([buy("o1", "hand-gold", "2025-02-11", "connected")]),
      holdings: [],
      links: [{ assetId: "hand-gold", productKey: "acc|isin:gold" }],
      portfolioLinks: [
        {
          addMemberAssetIds: [],
          portfolioId: portfolio.id,
          productKey: "portfolio:7",
          witness: null,
        },
      ],
      sourceId,
      today: TODAY,
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand-new",
      instrument: "fund",
      liquidityTier: "market",
      name: "Nuevo (a mano)",
      ownership: OWNER,
    });

    await expect(
      store.managedPortfolios.updateManagedPortfolio(portfolio.id, {
        memberHoldingIds: ["hand-new"],
      }),
    ).rejects.toThrow(/la pone al día una conexión/);
  });

  test("a cash link only takes a live manual cash account", async () => {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "not-cash",
      instrument: "fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: OWNER,
    });

    await expect(
      store.command.includeConnectedHoldings({
        cashLinks: [{ assetId: "not-cash", balanceMinor: 913, productKey: "cash:7" }],
        facts: facts([]),
        holdings: [],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/manual cash account/);
  });
});
