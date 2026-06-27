import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  listSources: vi.fn(async () => []),
  readAssets: vi.fn(async () => [
    {
      id: "asset_cash",
      name: "Caja",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 100_00, currency: "EUR" },
      liquidityTier: "cash",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: false,
    },
  ]),
  readFireConfig: vi.fn(async () => ({})),
  readOperations: vi.fn(async () => []),
  readPositions: vi.fn(async () => []),
  readSourceAssetIds: vi.fn(async () => []),
  readWarningOverrides: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ({
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  })),
  withStore: vi.fn(async (run: (store: unknown) => unknown) =>
    run({
      assets: { readAssets: calls.readAssets },
      connectedSources: {
        listSources: calls.listSources,
        listSourceAssetIds: calls.readSourceAssetIds,
        readPositions: calls.readPositions,
      },
      operations: { readOperations: calls.readOperations },
      readFireConfig: calls.readFireConfig,
      readWarningOverrides: calls.readWarningOverrides,
      workspace: { readWorkspace: calls.readWorkspace },
    }),
  ),
}));

vi.mock("@web/store", () => ({
  bootstrapHealthcheck: async () => ({
    status: "ok",
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt: "2026-06-27T00:00:00.000Z",
    checkValue: "2026-06-27T00:00:00.000Z",
    databasePath: ":memory:",
    displayPath: ":memory:",
  }),
  withStore: calls.withStore,
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

import AjustesPage from "./page";

describe("ajustes page data loading (#636)", () => {
  test("reuses store reads across the page render", async () => {
    await AjustesPage({ searchParams: Promise.resolve({}) });

    expect(calls.withStore).toHaveBeenCalledTimes(1);
    expect(calls.listSources).toHaveBeenCalledTimes(1);
    expect(calls.readAssets).toHaveBeenCalledTimes(1);
    expect(calls.readWarningOverrides).toHaveBeenCalledTimes(1);
  });
});
