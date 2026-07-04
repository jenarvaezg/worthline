/**
 * Wiring test for the portfolio-level "Importar extracto" entry point (PRD
 * #669 S3, #674, ADR 0055): the link next to "+ Añadir holding" reaches the
 * account-level import route, and — since it is a plain navigation link, not
 * a write — stays visible in demo mode (the write-gating lives downstream, on
 * the destination page's form and its server actions; mirrors ajustes/
 * page.test.tsx's store/demo mocking pattern).
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  buildProjectionContext: vi.fn(async () => ({
    cachedPriceByAsset: new Map(),
    manualPriceByAsset: new Map(),
    operationsByAsset: new Map(),
    ownershipByAsset: new Map(),
  })),
  isDemoMode: vi.fn(async () => false),
  readAllPriceCacheEntries: vi.fn(async () => []),
  readCurveValuedHoldingsAtDate: vi.fn(async () => ({ assets: [], liabilities: [] })),
  readExposureProfiles: vi.fn(async () => []),
  readInvestmentAssetsWithMeta: vi.fn(async () => []),
  readSnapshotHoldings: vi.fn(async () => []),
  readTrash: vi.fn(async () => ({ assets: [], liabilities: [] })),
  readWarningOverrides: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ({
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  })),
  withStore: vi.fn(async (run: (store: unknown) => unknown) =>
    run({
      assets: {
        readInvestmentAssetsWithMeta: calls.readInvestmentAssetsWithMeta,
      },
      exposureProfiles: { readExposureProfiles: calls.readExposureProfiles },
      operations: { readAllPriceCacheEntries: calls.readAllPriceCacheEntries },
      snapshots: {
        buildProjectionContext: calls.buildProjectionContext,
        readCurveValuedHoldingsAtDate: calls.readCurveValuedHoldingsAtDate,
        readSnapshotHoldings: calls.readSnapshotHoldings,
      },
      readTrash: calls.readTrash,
      readWarningOverrides: calls.readWarningOverrides,
      workspace: { readWorkspace: calls.readWorkspace },
    }),
  ),
}));

vi.mock("@web/store", () => ({
  bootstrapHealthcheck: async () => ({
    checkedAt: "2026-06-27T00:00:00.000Z",
    checkKey: "bootstrap.last_healthcheck_at",
    checkValue: "2026-06-27T00:00:00.000Z",
    databasePath: ":memory:",
    displayPath: ":memory:",
    status: "ok",
  }),
  withStore: calls.withStore,
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: calls.isDemoMode }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

// Shell (topnav, scope bar, warnings rail) carries its own client islands
// (useLinkStatus nav links) that suspend under a synchronous static render;
// it is irrelevant to this test, which only inspects the page's own children —
// mirrors how ajustes/page.test.tsx sidesteps unrelated complexity via mocks.
vi.mock("@web/shell", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

import PatrimonioPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await PatrimonioPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('"Importar extracto" portfolio entry point (S3, #674)', () => {
  test("links to /patrimonio/importar-extracto next to the add-holding entry", async () => {
    calls.isDemoMode.mockResolvedValueOnce(false);
    const html = await renderedHtml();

    expect(html).toContain('href="/patrimonio/importar-extracto"');
    expect(html).toContain("Importar extracto");
    expect(html).toContain('href="/patrimonio/anadir"');
  });

  test("stays visible in demo mode — the write-guard is downstream, not a hidden entry point", async () => {
    calls.isDemoMode.mockResolvedValueOnce(true);
    const html = await renderedHtml();

    expect(html).toContain('href="/patrimonio/importar-extracto"');
  });
});
