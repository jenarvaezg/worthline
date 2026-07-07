import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  readAmortizationPlan: vi.fn(async () => null),
  readAssets: vi.fn(async () => []),
  readDebtModel: vi.fn(async () => "amortizable"),
  readEarlyRepayments: vi.fn(async () => []),
  readInterestRateRevisions: vi.fn(async () => []),
  readLiabilities: vi.fn(async () => [
    {
      currency: "EUR",
      currentBalance: { amountMinor: 180_000_00, currency: "EUR" },
      id: "liability_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    },
  ]),
  readValuationCadence: vi.fn(async () => null),
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
      liabilities: {
        readAmortizationPlan: calls.readAmortizationPlan,
        readDebtModel: calls.readDebtModel,
        readEarlyRepayments: calls.readEarlyRepayments,
        readInterestRateRevisions: calls.readInterestRateRevisions,
        readLiabilities: calls.readLiabilities,
        readValuationCadence: calls.readValuationCadence,
      },
      readWarningOverrides: calls.readWarningOverrides,
      workspace: { readWorkspace: calls.readWorkspace },
    }),
  ),
}));

vi.mock("@web/store", () => ({
  bootstrapHealthcheck: async () => ({
    checkedAt: "2026-07-07T00:00:00.000Z",
    checkKey: "bootstrap.last_healthcheck_at",
    checkValue: "2026-07-07T00:00:00.000Z",
    databasePath: ":memory:",
    displayPath: ":memory:",
    status: "ok",
  }),
  withStore: calls.withStore,
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

vi.mock("@web/shell", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import EditarPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await EditarPage({
    params: Promise.resolve({ id: "liability_mortgage" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe("EditarPage progressive disclosure (#604)", () => {
  test("keeps mortgage basics open, machinery collapsed, and danger last", async () => {
    const html = await renderedHtml();
    const basic = html.indexOf("Lo básico");
    const balance = html.indexOf("Saldo pendiente");
    const advanced = html.indexOf("Configuración avanzada");
    const model = html.indexOf("Modelo de deuda");
    const danger = html.indexOf("Zona de peligro");

    expect(basic).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(basic);
    expect(advanced).toBeGreaterThan(balance);
    expect(model).toBeGreaterThan(advanced);
    expect(danger).toBeGreaterThan(model);
    expect(html).toContain("<summary>Configuración avanzada</summary>");

    const basicMarkup = html.slice(basic, advanced);
    expect(basicMarkup.match(/<form/g)?.length).toBe(2);
  });
});
