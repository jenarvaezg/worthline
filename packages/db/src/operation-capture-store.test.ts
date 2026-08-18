/**
 * The captured apunte survives the round-trip (#1401).
 *
 * A converted operation persists TWO facts: the euros the engine folds, and the
 * dollars the bank stated. The second one only earns its four columns if it comes
 * back out — and if an export → import cannot lose it, since that path writes the
 * rows through a different INSERT than `recordInvestmentOperation`.
 */

import { describe, expect, it } from "vitest";

import type { WorthlineStore } from "./index";
import { createInMemoryStore } from "./index";

const TODAY = "2026-08-18";
const MEMBER_ID = "mJ";

/** The father's 23-ene-2026 purchase: 2,04 US$ over 0,255 participaciones. */
const USD_BUY = {
  assetId: "fidelity",
  capture: {
    currency: "USD",
    eurPerUnit: 0.85,
    feesMinor: 150,
    pricePerUnit: "8.00",
  },
  currency: "EUR",
  executedAt: "2026-01-23",
  feesMinor: 128,
  id: "op_usd",
  kind: "buy",
  pricePerUnit: "6.8",
  units: "0.255",
} as const;

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fidelity",
    liquidityTier: "market",
    name: "Fidelity MSCI Pacific ex-Japan P-ACC-USD",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  return store;
}

describe("asset_operations capture columns", () => {
  it("reads back the currency, price, fees and rate the apunte was captured at", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(USD_BUY, { today: TODAY });

    const [operation] = await store.operations.readOperations("fidelity");

    expect(operation?.currency).toBe("EUR");
    expect(operation?.pricePerUnit).toBe("6.8");
    expect(operation?.capture).toEqual(USD_BUY.capture);
  });

  it("leaves the capture absent for a euro operation", async () => {
    const store = await seed();
    const { capture: _capture, ...euroBuy } = USD_BUY;
    await store.command.recordInvestmentOperation(
      { ...euroBuy, id: "op_eur" },
      { today: TODAY },
    );

    const [operation] = await store.operations.readOperations("fidelity");

    expect(operation?.capture).toBeUndefined();
  });

  it("survives an export → import round-trip", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(USD_BUY, { today: TODAY });

    const doc = await store.workspace.exportWorkspace();
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    const [operation] = await restored.operations.readOperations("fidelity");

    expect(operation?.capture).toEqual(USD_BUY.capture);
  });
});
