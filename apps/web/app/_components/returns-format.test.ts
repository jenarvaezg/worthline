import type { HoldingReturnsView } from "@worthline/domain";
import { APPRECIATING_CAVEAT, MARKET_CAVEAT, money } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { formatMeasurePct, formatRatioPct, returnsTooltipLines } from "./returns-format";

function marketView(overrides: Partial<HoldingReturnsView> = {}): HoldingReturnsView {
  return {
    annualized: true,
    cagr: 0.1,
    caveats: [MARKET_CAVEAT],
    irr: { rate: 0.082, reason: null },
    kind: "market",
    realizedPnl: null,
    totalGain: money(5_039_00, "EUR"),
    totalReturnRatio: 0.299,
    twr: { rate: 0.0738, provisional: true },
    unrealizedPnl: null,
    ...overrides,
  };
}

describe("formatRatioPct", () => {
  test("signs and localizes to es-ES", () => {
    expect(formatRatioPct(0.299)).toBe("+29,9 %");
    expect(formatRatioPct(-0.1)).toBe("−10,0 %");
    expect(formatRatioPct(0)).toBe("0,0 %");
  });
});

describe("formatMeasurePct", () => {
  test("a null measure is an em dash, not a fabricated number", () => {
    expect(formatMeasurePct(null)).toBe("—");
    expect(formatMeasurePct(0.082)).toBe("+8,2 %");
  });
});

describe("returnsTooltipLines", () => {
  test("market: three measures, annualized label, provisional TWR and caveat", () => {
    const lines = returnsTooltipLines(marketView());
    expect(lines).toContain("Ganancia total: +29,9 %");
    expect(lines).toContain("Anualizada (CAGR): +10,0 %");
    expect(lines).toContain("IRR anual: +8,2 %");
    expect(lines).toContain("TWR (provisional): +7,4 %");
    expect(lines).toContain(MARKET_CAVEAT);
  });

  test("sub-year span omits the annualized line", () => {
    const lines = returnsTooltipLines(marketView({ annualized: false, cagr: null }));
    expect(lines.some((line) => line.startsWith("Anualizada"))).toBe(false);
  });

  test("a failed IRR/TWR renders as em dashes", () => {
    const lines = returnsTooltipLines(
      marketView({
        irr: { rate: null, reason: "single_sign" },
        twr: { rate: null, provisional: true },
      }),
    );
    expect(lines).toContain("IRR anual: —");
    expect(lines).toContain("TWR (provisional): —");
  });

  test("appreciating: only revalorización, no IRR/TWR, with its caveat", () => {
    const lines = returnsTooltipLines({
      annualized: false,
      cagr: null,
      caveats: [APPRECIATING_CAVEAT],
      irr: null,
      kind: "appreciating",
      realizedPnl: null,
      totalGain: money(20_000_00, "EUR"),
      totalReturnRatio: 0.15,
      twr: null,
      unrealizedPnl: null,
    });
    expect(lines).toContain("Revalorización: +15,0 % (valor actual − coste)");
    expect(lines.some((line) => line.startsWith("IRR"))).toBe(false);
    expect(lines).toContain(APPRECIATING_CAVEAT);
  });
});
