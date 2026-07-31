/**
 * The «puesta al día» offers a hand-editable figure per holding — and only where
 * hand-editing is the door. Assets are cribbed by `isValueUpdateEligible` (a
 * derived investment is never listed); debts are cribbed by the same rule the
 * ficha applies (#1290): once a plan, a re-baseline or a declared balance exists,
 * the balance comes from the curve and the stored field is dead, so an input here
 * would be a «guardado» that moves no figure (#1334).
 */
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  readAssets: vi.fn(async (): Promise<unknown[]> => []),
  readCurveGovernedLiabilityIds: vi.fn(async () => new Set<string>()),
  readLiabilities: vi.fn(
    async (): Promise<unknown[]> => [
      {
        currency: "EUR",
        currentBalance: { amountMinor: 180_000_00, currency: "EUR" },
        id: "liability_mortgage",
        name: "Hipoteca",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "mortgage",
      },
      {
        currency: "EUR",
        currentBalance: { amountMinor: 1_200_00, currency: "EUR" },
        id: "liability_card",
        name: "Tarjeta",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "debt",
      },
    ],
  ),
  resolvePageShell: vi.fn(async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        assets: { readAssets: calls.readAssets },
        liabilities: {
          readCurveGovernedLiabilityIds: calls.readCurveGovernedLiabilityIds,
          readLiabilities: calls.readLiabilities,
        },
      },
      target: { kind: "local" },
      workspace: {
        baseCurrency: "EUR",
        groups: [],
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      },
    };
  }),
}));

vi.mock("@web/page-shell", () => ({ resolvePageShell: calls.resolvePageShell }));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import PuestaAlDiaPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await PuestaAlDiaPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe("PuestaAlDiaPage — debts whose figure comes from the curve (#1334)", () => {
  test("with no curve anywhere every debt keeps its balance input", async () => {
    const html = await renderedHtml();

    expect(html).toContain("Saldo de Hipoteca en EUR");
    expect(html).toContain("Saldo de Tarjeta en EUR");
    expect(html).toContain('name="val_liability_mortgage"');
    expect(html).toContain('name="val_liability_card"');
  });

  test("a debt governed by its curve is not offered a balance input", async () => {
    calls.readCurveGovernedLiabilityIds.mockResolvedValueOnce(
      new Set(["liability_mortgage"]),
    );

    const html = await renderedHtml();

    // The mortgage's figure comes from its plan/re-baseline — no input, and no
    // stale 180.000 € prefilled as if it were the balance to confirm.
    expect(html).not.toContain("Saldo de Hipoteca en EUR");
    expect(html).not.toContain('name="val_liability_mortgage"');
    // …and the debt next to it, which has no curve, is untouched.
    expect(html).toContain("Saldo de Tarjeta en EUR");
    expect(html).toContain('name="val_liability_card"');
  });

  test("all debts governed and no manual assets leaves the empty state, not an empty form", async () => {
    calls.readCurveGovernedLiabilityIds.mockResolvedValueOnce(
      new Set(["liability_mortgage", "liability_card"]),
    );

    const html = await renderedHtml();

    expect(html).toContain("Sin activos ni deudas manuales.");
    expect(html).not.toContain('name="val_liability_card"');
  });
});
