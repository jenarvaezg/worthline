import type { PortfolioCost } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  formatTerPercent,
  portfolioCostCoverageParts,
  readPortfolioCost,
} from "./portfolio-cost-view";

const EUR = "EUR";

function eur(amountMinor: number) {
  return { amountMinor, currency: EUR };
}

function cost(overrides: Partial<PortfolioCost>): PortfolioCost {
  return {
    annualCost: eur(0),
    coverage: { classified: eur(0), notApplicable: eur(0), unknown: eur(0) },
    declaredShare: "0",
    weightedTer: null,
    ...overrides,
  };
}

describe("formatTerPercent", () => {
  test("prints a TER fraction as an es-ES percent with two decimals", () => {
    expect(formatTerPercent("0.0018")).toBe("0,18 %");
    expect(formatTerPercent("0.002")).toBe("0,20 %");
    expect(formatTerPercent("0.0125")).toBe("1,25 %");
  });
});

describe("readPortfolioCost", () => {
  test("with a declared TER it reads the yearly cost, the mean and its base", () => {
    const reading = readPortfolioCost(
      cost({
        annualCost: eur(180_00),
        coverage: {
          classified: eur(60_000_00),
          notApplicable: eur(10_000_00),
          unknown: eur(30_000_00),
        },
        declaredShare: "0.6",
        weightedTer: "0.003",
      }),
    );

    expect(reading).toEqual({
      annualCost: eur(180_00),
      kind: "estimated",
      shareLabel: "60 %",
      terLabel: "0,30 %",
    });
  });

  test("a sliver of declared gross never reads as «el 0 % del bruto»", () => {
    const reading = readPortfolioCost(
      cost({
        annualCost: eur(1_00),
        coverage: {
          classified: eur(500_00),
          notApplicable: eur(0),
          unknown: eur(199_500_00),
        },
        declaredShare: "0.0025",
        weightedTer: "0.002",
      }),
    );

    expect(reading).toMatchObject({ kind: "estimated", shareLabel: "menos del 1 %" });
  });

  test("funds with no TER declared read as the gap, never as a free portfolio", () => {
    const reading = readPortfolioCost(
      cost({ coverage: { classified: eur(0), notApplicable: eur(0), unknown: eur(1) } }),
    );

    expect(reading).toEqual({ kind: "undeclared" });
  });

  test("a portfolio with nothing that charges a TER says so", () => {
    const reading = readPortfolioCost(
      cost({
        coverage: { classified: eur(0), notApplicable: eur(5_000_00), unknown: eur(0) },
      }),
    );

    expect(reading).toEqual({ kind: "none" });
  });
});

describe("portfolioCostCoverageParts", () => {
  test("names the three parts in TER words, zero parts kept", () => {
    const parts = portfolioCostCoverageParts({
      classified: eur(60_000_00),
      notApplicable: eur(0),
      unknown: eur(40_000_00),
    });

    expect(parts).toEqual([
      { kind: "classified", label: "Con TER", value: eur(60_000_00) },
      { kind: "notApplicable", label: "No aplica", value: eur(0) },
      { kind: "unknown", label: "Sin declarar", value: eur(40_000_00) },
    ]);
  });
});
