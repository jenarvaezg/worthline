/**
 * The chat-confirmed alta answers a refusal with a sentence, never with a
 * fantasma (#1599).
 *
 * `persistHoldingCreation` promises `{ ok: false, error }` on a domain violation
 * and never throws — and since the alta became ONE unit of work, the seam it
 * writes through can refuse with data of its own (the traspaso gate reads the
 * destination's currency, which only exists once the row does). This pins that
 * the refusal is read and mapped, instead of being dropped into an `{ ok: true }`
 * for a holding the rollback already took away.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test, vi } from "vitest";

import { persistHoldingCreation } from "./persist-holding-creation";

vi.mock("@web/first-quote", () => ({
  fetchFirstQuoteBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@web/ensure-exposure-catalog-stubs", () => ({
  ensureExposureCatalogStubs: vi.fn(async () => undefined),
}));
vi.mock("@web/activation-marks", () => ({
  markFirstHoldingBestEffort: vi.fn(async () => undefined),
}));

const TODAY = "2026-08-26";
const NOW = "2026-08-26T10:00:00Z";

async function seedWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

const PLAN = {
  family: "investment" as const,
  instrument: "fund" as const,
  name: "Fondo Vanguard",
  ownership: [{ memberId: "m", shareBps: 10_000 }],
  providerSymbol: "VANGTLI",
};

describe("persistHoldingCreation — the alta's refusal is a message", () => {
  test("a seam that refuses comes back as a Spanish error, not as a created holding", async () => {
    const store = await seedWorkspace();
    const refusing = {
      ...store,
      command: {
        ...store.command,
        createInvestmentHolding: async () => ({
          ok: false as const,
          violations: [
            {
              code: "transfer_price_not_positive" as const,
              side: "destination" as const,
            },
          ] as [{ code: "transfer_price_not_positive"; side: "destination" }],
        }),
      },
    } as unknown as WorthlineStore;

    const result = await persistHoldingCreation(refusing, PLAN, 1, TODAY, NOW);

    expect(result.ok).toBe(false);
    expect(await store.assets.readAssets()).toHaveLength(0);
  });

  test("an accepted alta still reports the holding it created", async () => {
    const store = await seedWorkspace();

    const result = await persistHoldingCreation(store, PLAN, 1, TODAY, NOW);

    expect(result.ok).toBe(true);
    expect(await store.assets.readAssets()).toHaveLength(1);
  });
});
