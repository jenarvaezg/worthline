/**
 * Wiring test for the "Repasar con el asistente" re-run entry point (PRD #1167
 * S3, #1170): on a portfolio that already has holdings, the /patrimonio header
 * shows the shortcut whose href carries the one-shot `repasar=1` flag, preserving
 * any pre-existing params. The premium gate is downstream at the chat route
 * (#1162); this only checks the entry point wires up. Child sections are stubbed
 * so the render stays focused on the header links.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  isDemoMode: vi.fn(async () => false),
  loadPatrimonio: vi.fn(async () => ({
    exposureEquity: null,
    exposureFull: null,
    groups: [],
    hasHoldings: true,
    hasPricedHoldings: false,
    operatedAssetIds: new Set<string>(),
    returnsByClass: null,
    returnsById: new Map(),
    trash: { assets: [], liabilities: [] },
    warnings: [],
  })),
  resolvePageShell: vi.fn(async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      persistence: {
        checkedAt: "2026-06-27T00:00:00.000Z",
        checkKey: "bootstrap.last_healthcheck_at",
        checkValue: "2026-06-27T00:00:00.000Z",
        databasePath: ":memory:",
        displayPath: ":memory:",
        status: "ok",
      },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {},
      target: { kind: "local" },
      workspace: { baseCurrency: "EUR", groups: [], members: [], mode: "individual" },
    };
  }),
}));

vi.mock("@web/page-shell", () => ({ resolvePageShell: calls.resolvePageShell }));
vi.mock("@web/demo/write-guard", () => ({ isDemoMode: calls.isDemoMode }));
vi.mock("./load-patrimonio", () => ({ loadPatrimonio: calls.loadPatrimonio }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

// Keep the render focused on the header's own links — stub the section islands.
vi.mock("./balance-board", () => ({ default: () => null }));
vi.mock("./exposure-section", () => ({ default: () => null }));
vi.mock("./returns-by-class-section", () => ({ default: () => null }));
vi.mock("./group-controls", () => ({ default: () => null }));
vi.mock("./price-refresh-control", () => ({ PriceRefreshControl: () => null }));

import PatrimonioPage from "./page";

async function renderedHtml(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  const element = (await PatrimonioPage({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('"Repasar con el asistente" re-run entry point (S3, #1170)', () => {
  test("shows the shortcut with the one-shot repasar flag when holdings exist", async () => {
    const html = await renderedHtml({});

    expect(html).toContain("Repasar con el asistente");
    expect(html).toContain("repasar=1");
  });

  test("preserves pre-existing params in the shortcut href", async () => {
    const html = await renderedHtml({ group: "class" });

    expect(html).toContain("group=class");
    expect(html).toContain("repasar=1");
  });
});
