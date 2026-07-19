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
  resolvePageShell: vi.fn(async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      persistence: {
        status: "ok",
        checkKey: "bootstrap.last_healthcheck_at",
        checkedAt: "2026-06-27T00:00:00.000Z",
        checkValue: "2026-06-27T00:00:00.000Z",
        databasePath: ":memory:",
        displayPath: ":memory:",
      },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        assets: { readAssets: calls.readAssets },
        connectedSources: {
          listSources: calls.listSources,
          listSourceAssetIds: calls.readSourceAssetIds,
          readPositions: calls.readPositions,
        },
        operations: { readOperations: calls.readOperations },
        readFireConfig: calls.readFireConfig,
        readWarningOverrides: calls.readWarningOverrides,
      },
      target: { kind: "local" },
      workspace: await calls.readWorkspace(),
    };
  }),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: calls.resolvePageShell,
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

    expect(calls.resolvePageShell).toHaveBeenCalledTimes(1);
    expect(calls.listSources).toHaveBeenCalledTimes(1);
    expect(calls.readAssets).toHaveBeenCalledTimes(1);
    expect(calls.readWarningOverrides).toHaveBeenCalledTimes(1);
  });
});
