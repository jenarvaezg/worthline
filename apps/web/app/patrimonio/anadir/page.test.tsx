/**
 * Wiring test for the add-holding wizard's "Importar extracto" entry point
 * (PRD #669 S3, #674, ADR 0055): inside the investment drawer's "Tengo el
 * extracto del bróker" pane, a link reaches the account-level import route —
 * the same preview/confirm flow the portfolio-level entry point uses, not a
 * copy. It appears only for the "Cotiza en bolsa" (fund) group, since the
 * multi-ISIN engine creates fund investments; the per-holding single-fund path
 * in that same pane (#176's "Cargar movimientos") is unchanged.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  readAssets: vi.fn(async () => []),
  readLiabilities: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ({
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  })),
  withStore: vi.fn(async (run: (store: unknown) => unknown) =>
    run({
      assets: { readAssets: calls.readAssets },
      liabilities: { readLiabilities: calls.readLiabilities },
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

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

// Shell's client islands (useLinkStatus nav links) suspend under a synchronous
// static render and are irrelevant here — see patrimonio/page.test.tsx.
vi.mock("@web/shell", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

// PendingSubmit's useFormStatus() also suspends outside a real form-action
// lifecycle; irrelevant to the link being tested.
vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => children,
}));

// SymbolSearch is an async server component rendered inline (no await by the
// caller); react-dom/server's static renderer suspends on it outside a real
// RSC pipeline. It renders per investment group and is irrelevant here.
vi.mock("@web/patrimonio/anadir/symbol-search", () => ({
  default: () => null,
}));

import AnadirHoldingPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await AnadirHoldingPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('"Importar extracto" wizard entry point (S3, #674)', () => {
  test("the investment import pane links to the account-level import flow", async () => {
    const html = await renderedHtml();

    expect(html).toContain('href="/patrimonio/importar-extracto"');
    expect(html).toContain("Importar extracto de toda la cartera");
    // The unchanged one-fund case still routes through "Cargar movimientos".
    expect(html).toContain("Cargar movimientos");
  });

  test("the account-import link appears exactly once — only under the fund group, not pension_plan/crypto", async () => {
    const html = await renderedHtml();
    const occurrences = html.split('href="/patrimonio/importar-extracto"').length - 1;
    expect(occurrences).toBe(1);
  });
});
