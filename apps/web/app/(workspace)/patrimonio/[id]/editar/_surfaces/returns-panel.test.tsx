import type { HoldingReturnsView } from "@worthline/domain";
import {
  costBasisGradeMark,
  formatMoneyMinorPrivacy,
  MARKET_PAYOUTS_CAVEAT,
  money,
} from "@worthline/domain";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ReturnsPanel } from "./returns-panel";

/**
 * The ficha's «Rentabilidad» tab (#1830, spec #1731): two questions faced, not five
 * measures in a column. «Tu dinero (TIR)» answers how the owner did — when each euro
 * went in counts — with the realized gain against the latent one; «El fondo (TWR)»
 * answers how the product did regardless of those dates, which is the measure an
 * index is compared against, so the comparison sits on its side (ADR 0040).
 */

const eur = (amountMinor: number) =>
  formatMoneyMinorPrivacy({ amountMinor, currency: "EUR" }, false);

/** Two and a half years held: every measure is annual and measurable. */
function view(overrides: Partial<HoldingReturnsView> = {}): HoldingReturnsView {
  return {
    annualized: true,
    cagr: 0.118,
    caveats: [MARKET_PAYOUTS_CAVEAT],
    costBasisGrade: null,
    irr: { rate: 0.072, reason: null },
    kind: "market",
    realizedPnl: money(300_00, "EUR"),
    totalGain: money(2_500_00, "EUR"),
    totalReturnRatio: 0.25,
    twr: {
      annualized: true,
      annualizedRate: 0.061,
      endDate: "2026-09-30",
      rate: 0.18,
      reason: null,
      spanDays: 943,
      startDate: "2024-03-01",
    },
    unrealizedPnl: money(2_000_00, "EUR"),
    ...overrides,
  };
}

function render(v: HoldingReturnsView, benchmark?: ReactNode) {
  return renderToStaticMarkup(
    <ReturnsPanel benchmark={benchmark} privacyMode={false} view={v} />,
  );
}

/** The markup of each side: the owner's money, then the product. */
function sides(markup: string) {
  const fundAt = markup.indexOf("El fondo");
  expect(markup.indexOf("Tu dinero")).toBeGreaterThan(-1);
  expect(fundAt).toBeGreaterThan(markup.indexOf("Tu dinero"));
  return { fund: markup.slice(fundAt), money: markup.slice(0, fundAt) };
}

describe("ReturnsPanel — your money against the fund (#1830)", () => {
  test("each side leads with its own annual figure: the TIR, then the TWR", () => {
    const { fund, money: mine } = sides(render(view()));

    expect(mine).toContain(">TIR</abbr>");
    expect(mine).toContain("+7,2 %");
    expect(mine).toContain("al año");
    expect(fund).toContain(">TWR</abbr>");
    expect(fund).toContain("+6,1 %");
    // The TWR's total over its span, dated: nothing is measured before it.
    expect(fund).toContain("+18,0 %");
    expect(fund).toContain("01/03/2024");
    // Neither side's figure leaks into the other.
    expect(mine).not.toContain("+6,1 %");
    expect(fund).not.toContain("+7,2 %");
  });

  test("the owner's side carries the gain in euros, the realized against the latent", () => {
    const { fund, money: mine } = sides(render(view()));

    expect(mine).toContain("Ganancia total");
    expect(mine).toContain(`+${eur(2_500_00)} · +25,0 %`);
    expect(mine).toContain("Realizada");
    expect(mine).toContain(`+${eur(300_00)}`);
    expect(mine).toContain("Latente");
    expect(mine).toContain(`+${eur(2_000_00)}`);
    // The simple gain annualized is a money measure too, and says it is unweighted.
    expect(mine).toContain("+11,8 %");
    expect(fund).not.toContain("Realizada");
  });

  test("the comparison with the index sits beside the TWR it compares", () => {
    const { fund, money: mine } = sides(
      render(view(), <p className="benchmarkStub">vs MSCI World</p>),
    );

    expect(fund).toContain("vs MSCI World");
    expect(mine).not.toContain("vs MSCI World");
  });

  test("a measure that could not be computed says why, never a number", () => {
    const { fund, money: mine } = sides(
      render(
        view({
          irr: { rate: null, reason: "zero_time_span" },
          twr: {
            annualized: false,
            annualizedRate: null,
            endDate: null,
            rate: null,
            reason: "insufficient_monthly_closes",
            spanDays: 0,
            startDate: null,
          },
        }),
      ),
    );

    expect(mine).toContain("—");
    expect(mine).toContain("Sin TIR: todos los movimientos son del mismo día.");
    expect(fund).toContain("—");
    expect(fund).toContain("Sin TWR: hacen falta al menos dos cierres mensuales.");
    expect(fund).not.toContain("al año");
  });

  test("with no monthly closes at all, the fund's side still says what is missing", () => {
    const { fund } = sides(render(view({ twr: null })));

    expect(fund).toContain("—");
    expect(fund).toContain("Sin TWR:");
  });

  test("a span under a year stays total on both sides — never annualized (ADR 0040)", () => {
    const markup = render(
      view({
        annualized: false,
        cagr: null,
        twr: {
          annualized: false,
          annualizedRate: null,
          endDate: "2026-09-30",
          rate: 0.03,
          reason: null,
          spanDays: 120,
          startDate: "2026-06-01",
        },
      }),
    );
    const { fund, money: mine } = sides(markup);

    expect(mine).toContain("Ganancia total (no anual)");
    expect(mine).not.toContain("CAGR");
    expect(fund).toContain("+3,0 %");
    expect(fund).toContain("en total, no anual");
    expect(fund).toContain("01/06/2026");
    expect(fund).not.toContain("al año");
  });

  test("a cost nobody declared withholds the latent figure and says so in its slot (#1505)", () => {
    const { money: mine } = sides(
      render(view({ costBasisGrade: "value_only", unrealizedPnl: null })),
    );

    expect(mine).toContain("Latente");
    expect(mine).toContain(costBasisGradeMark("value_only"));
  });

  test("the honest caveats stay on show", () => {
    expect(render(view())).toContain(MARKET_PAYOUTS_CAVEAT);
  });

  test("figures are signed by their movement and masked in privacy mode", () => {
    const loss = render(
      view({
        irr: { rate: -0.04, reason: null },
        totalGain: money(-800_00, "EUR"),
        totalReturnRatio: -0.08,
      }),
    );
    expect(loss).toContain("−4,0 %");
    expect(loss).toMatch(/class="[^"]*neg[^"]*"[^>]*>−4,0 %/);

    const hidden = renderToStaticMarkup(
      <ReturnsPanel privacyMode={true} view={view()} />,
    );
    expect(hidden).not.toContain(eur(2_500_00));
  });
});
