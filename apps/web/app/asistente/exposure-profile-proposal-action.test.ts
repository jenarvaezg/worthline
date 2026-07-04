import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { readStoreTarget } from "@web/read-store-target";

import { confirmExposureProfileProposalAction } from "./exposure-profile-proposal-action";

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: vi.fn(async () => ({ kind: "local" })),
}));

async function seedFund(
  store: WorthlineStore,
  input: { id: string; isin: string; name: string },
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: input.id,
    instrument: "etf",
    isin: input.isin,
    liquidityTier: "market",
    name: input.name,
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    providerSymbol: input.id.toUpperCase(),
  });
}

describe("confirmExposureProfileProposalAction", () => {
  beforeEach(() => {
    vi.mocked(readStoreTarget).mockResolvedValue({ kind: "local" });
  });

  test("confirms a batch with agent provenance and preserves omitted existing fields", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await seedFund(store, {
      id: "world",
      isin: "IE00B4L5Y983",
      name: "iShares MSCI World",
    });
    await seedFund(store, {
      id: "sp500",
      isin: "IE00B5BMR087",
      name: "Vanguard S&P 500",
    });
    await store.exposureProfiles.saveExposureProfile({
      key: "IE00B4L5Y983",
      source: "user",
      ter: "0.002",
    });

    const result = await confirmExposureProfileProposalAction(
      [
        {
          key: "IE00B4L5Y983",
          breakdowns: { geography: { us: "0.7" } },
          trackedIndex: "MSCI World",
        },
        {
          key: "IE00B5BMR087",
          breakdowns: { assetClass: { equity: "1" } },
        },
      ],
      store,
      "2026-07-04T12:00:00.000Z",
    );

    expect(result).toEqual({ applied: 2, status: "applied" });
    expect(
      await store.exposureProfiles.readExposureProfile("IE00B4L5Y983"),
    ).toMatchObject({
      breakdowns: { geography: { us: "0.7" } },
      declaredAt: "2026-07-04T12:00:00.000Z",
      source: "agent",
      ter: "0.002",
      trackedIndex: "MSCI World",
    });
    expect(
      await store.exposureProfiles.readExposureProfile("IE00B5BMR087"),
    ).toMatchObject({
      breakdowns: { assetClass: { equity: "1" } },
      declaredAt: "2026-07-04T12:00:00.000Z",
      source: "agent",
    });
  });

  test("rejects malformed draft buckets without writing", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await seedFund(store, {
      id: "world",
      isin: "IE00B4L5Y983",
      name: "iShares MSCI World",
    });

    const result = await confirmExposureProfileProposalAction(
      [{ key: "IE00B4L5Y983", breakdowns: { geography: { mars: "0.2" } } }],
      store,
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.status).toBe("error");
    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
  });

  test("rejects over-100 breakdowns at confirm", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await seedFund(store, {
      id: "world",
      isin: "IE00B4L5Y983",
      name: "iShares MSCI World",
    });

    const result = await confirmExposureProfileProposalAction(
      [
        {
          key: "IE00B4L5Y983",
          breakdowns: { geography: { europe_developed: "0.4", us: "0.8" } },
        },
      ],
      store,
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.status).toBe("error");
    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
  });

  test("rejects keys that do not resolve to hand-entry-eligible holdings", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "bitcoin",
      instrument: "crypto",
      liquidityTier: "market",
      name: "Bitcoin",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      providerSymbol: "BTC",
    });

    const result = await confirmExposureProfileProposalAction(
      [{ key: "BTC", breakdowns: { assetClass: { crypto: "1" } } }],
      store,
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.status).toBe("error");
    expect(await store.exposureProfiles.readExposureProfile("BTC")).toBeNull();
  });

  test("is a no-op in demo mode", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({
      kind: "demo",
      now: "2026-07-04",
      persona: "inversor",
    });
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await seedFund(store, {
      id: "world",
      isin: "IE00B4L5Y983",
      name: "iShares MSCI World",
    });

    const result = await confirmExposureProfileProposalAction(
      [{ key: "IE00B4L5Y983", breakdowns: { geography: { us: "1" } } }],
      store,
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.status).toBe("blocked");
    expect(await store.exposureProfiles.readExposureProfile("IE00B4L5Y983")).toBeNull();
  });
});
