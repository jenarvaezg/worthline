import { describe, expect, test } from "vitest";

import { createFxRateSnapshot } from "./fx";
import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
} from "./investment-types";
import {
  convertOperationToBaseCurrency,
  lastCapturedCurrency,
  mixedCurrencyWarning,
} from "./operation-currency";

/**
 * The #1401 seam: an apunte captured in dollars becomes euros through the ECB rate
 * of ITS execution date, and a ledger that ended up mixing currencies says so.
 *
 * The numbers are the father's real MyInvestor purchases of
 * `Fidelity MSCI Pacific ex-Japan Index Fund P-ACC-USD`, the eight operations that
 * landed as `0.255 @ 8.00 EUR` when 8,00 was dollars — a +17,7 % inflated cost.
 */

const USD_RATES = createFxRateSnapshot({
  // 23-ene-2026 and 11-feb-2026, EUR per one USD.
  USD: [
    { dateKey: "2026-01-23", eurPerUnit: 0.85 },
    { dateKey: "2026-02-11", eurPerUnit: 0.9 },
  ],
});

function usdBuy(
  overrides: Partial<CreateInvestmentOperationInput> = {},
): CreateInvestmentOperationInput {
  return {
    assetId: "asset_fidelity",
    currency: "USD",
    executedAt: "2026-01-23",
    feesMinor: 0,
    id: "op_1",
    kind: "buy",
    pricePerUnit: "8.00",
    units: "0.255",
    ...overrides,
  };
}

describe("convertOperationToBaseCurrency — the dated conversion at capture", () => {
  test("re-expresses the unit price in EUR with the rate of the execution date", () => {
    const result = convertOperationToBaseCurrency(usdBuy(), USD_RATES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe("EUR");
    // 8,00 US$ × 0,85 = 6,80 €, NOT the 8,00 «€» that got stored.
    expect(result.value.pricePerUnit).toBe("6.8");
  });

  test("uses each operation's OWN date, never the latest rate", () => {
    const february = convertOperationToBaseCurrency(
      usdBuy({ executedAt: "2026-02-11", pricePerUnit: "8.3282674772" }),
      USD_RATES,
    );

    expect(february.ok).toBe(true);
    if (!february.ok) return;
    // × 0,90 (February), not × 0,85 (January).
    expect(february.value.pricePerUnit).toBe("7.49544073");
  });

  test("keeps the original apunte so the conversion can be audited", () => {
    const result = convertOperationToBaseCurrency(usdBuy({ feesMinor: 150 }), USD_RATES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capture).toEqual({
      currency: "USD",
      eurPerUnit: 0.85,
      feesMinor: 150,
      pricePerUnit: "8.00",
    });
  });

  test("converts the fees through the same rate", () => {
    const result = convertOperationToBaseCurrency(usdBuy({ feesMinor: 200 }), USD_RATES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2,00 US$ × 0,85 = 1,70 €.
    expect(result.value.feesMinor).toBe(170);
  });

  test("carries a weekend execution back to the previous business day's rate", () => {
    // 2026-01-24 is a Saturday: ECB publishes nothing, so the 23rd carries forward
    // — the same policy as the aggregation (FX_CARRY_FORWARD_DAYS).
    const result = convertOperationToBaseCurrency(
      usdBuy({ executedAt: "2026-01-24" }),
      USD_RATES,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pricePerUnit).toBe("6.8");
  });

  test("refuses the capture when no rate covers the date", () => {
    const result = convertOperationToBaseCurrency(
      usdBuy({ executedAt: "2025-03-04" }),
      USD_RATES,
    );

    expect(result).toEqual({
      ok: false,
      violations: [
        {
          code: "operation_currency_missing_rate",
          currency: "USD",
          executedAt: "2025-03-04",
        },
      ],
    });
  });

  test("passes a EUR apunte through untouched, with no capture", () => {
    const input = usdBuy({ currency: "EUR" });
    const result = convertOperationToBaseCurrency(input, USD_RATES);

    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) return;
    expect(result.value.capture).toBeUndefined();
  });

  test("is idempotent: converting its own output changes nothing", () => {
    const once = convertOperationToBaseCurrency(usdBuy(), USD_RATES);
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = convertOperationToBaseCurrency(once.value, USD_RATES);
    expect(twice).toEqual({ ok: true, value: once.value });
  });
});

describe("mixedCurrencyWarning — the guard where a comment used to be", () => {
  function op(overrides: Partial<InvestmentOperation>): InvestmentOperation {
    return {
      assetId: "asset_fidelity",
      currency: "EUR",
      executedAt: "2026-01-23",
      feesMinor: 0,
      id: "op_1",
      kind: "buy",
      pricePerUnit: "6.8",
      units: "0.255",
      ...overrides,
    };
  }

  test("stays silent when every operation shares the folded currency", () => {
    expect(mixedCurrencyWarning([op({}), op({ id: "op_2" })], "EUR")).toBeNull();
  });

  test("stays silent on an empty ledger", () => {
    expect(mixedCurrencyWarning([], "EUR")).toBeNull();
  });

  test("names every currency present when the ledger mixes them", () => {
    const warning = mixedCurrencyWarning(
      [op({}), op({ currency: "USD", id: "op_2" }), op({ currency: "GBP", id: "op_3" })],
      "EUR",
    );

    expect(warning).toContain("EUR");
    expect(warning).toContain("USD");
    expect(warning).toContain("GBP");
  });

  test("warns when the whole ledger is in a currency the fold does NOT use", () => {
    // The silent mis-sum #1401 is about: every operation in USD, folded and
    // labelled as the asset's EUR.
    expect(mixedCurrencyWarning([op({ currency: "USD" })], "EUR")).not.toBeNull();
  });
});

describe("lastCapturedCurrency — typing the currency once", () => {
  function op(id: string, capture?: { currency: string }): InvestmentOperation {
    return {
      assetId: "asset_fidelity",
      currency: "EUR",
      executedAt: "2026-01-23",
      feesMinor: 0,
      id,
      kind: "buy",
      pricePerUnit: "6.8",
      units: "0.255",
      ...(capture === undefined
        ? {}
        : {
            capture: {
              currency: capture.currency,
              eurPerUnit: 0.85,
              feesMinor: 0,
              pricePerUnit: "8.00",
            },
          }),
    };
  }

  test("answers the last captured currency in the canonical ledger", () => {
    expect(
      lastCapturedCurrency([
        op("op_1", { currency: "USD" }),
        op("op_2", { currency: "GBP" }),
      ]),
    ).toBe("GBP");
  });

  test("skips euro operations recorded after a captured one", () => {
    // A EUR apunte is not a statement that the fund stopped being a dollar fund.
    expect(lastCapturedCurrency([op("op_1", { currency: "USD" }), op("op_2")])).toBe(
      "USD",
    );
  });

  test("answers undefined for a ledger that never captured a currency", () => {
    expect(lastCapturedCurrency([op("op_1"), op("op_2")])).toBeUndefined();
    expect(lastCapturedCurrency([])).toBeUndefined();
  });
});
