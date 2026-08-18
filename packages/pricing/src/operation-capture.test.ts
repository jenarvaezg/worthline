/**
 * The capture door (#1401): one ECB request per currency, each row converted at the
 * rate of its OWN execution date, and one unconvertible row refusing the batch.
 */

import type { CreateInvestmentOperationInput } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import {
  convertCapturedOperation,
  convertCapturedOperations,
  convertStatementRows,
} from "./operation-capture";

/** EUR per USD, three business days across two months. */
const USD_SERIES = new Map([
  ["2026-01-23", 0.85],
  ["2026-02-11", 0.9],
  ["2026-04-30", 0.88],
]);

function usdBuy(
  executedAt: string,
  pricePerUnit: string,
  overrides: Partial<CreateInvestmentOperationInput> = {},
): CreateInvestmentOperationInput {
  return {
    assetId: "fidelity",
    currency: "USD",
    executedAt,
    feesMinor: 0,
    id: `op_${executedAt}`,
    kind: "buy",
    pricePerUnit,
    units: "1",
    ...overrides,
  };
}

describe("convertCapturedOperations", () => {
  it("fetches ONE window per currency for a whole statement", async () => {
    const calls: Array<[string, number, number]> = [];
    const fetchDailyRates = async (currency: string, fromMs: number, toMs: number) => {
      calls.push([currency, fromMs, toMs]);
      return USD_SERIES;
    };

    await convertCapturedOperations(
      [
        usdBuy("2026-01-23", "8.00"),
        usdBuy("2026-02-11", "8.3282674772"),
        usdBuy("2026-04-30", "8.1949934123"),
      ],
      { fetchDailyRates },
    );

    expect(calls).toHaveLength(1);
    const [currency, fromMs, toMs] = calls[0]!;
    expect(currency).toBe("USD");
    // The window reaches back BEFORE the earliest date (carry-forward slack) and
    // forward to the latest.
    expect(new Date(fromMs).toISOString().slice(0, 10)).toBe("2026-01-16");
    expect(new Date(toMs).toISOString().slice(0, 10)).toBe("2026-04-30");
  });

  it("converts each row at its own date, not at one shared rate", async () => {
    const result = await convertCapturedOperations(
      [usdBuy("2026-01-23", "8.00"), usdBuy("2026-02-11", "8.00")],
      { fetchDailyRates: async () => USD_SERIES },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((operation) => operation.pricePerUnit)).toEqual([
      "6.8",
      "7.2",
    ]);
  });

  it("costs nothing when every apunte is already in euros", async () => {
    let fetched = false;
    const euroBuy = usdBuy("2026-01-23", "8.00", { currency: "EUR" });

    const result = await convertCapturedOperations([euroBuy], {
      fetchDailyRates: async () => {
        fetched = true;
        return USD_SERIES;
      },
    });

    expect(fetched).toBe(false);
    expect(result).toEqual({ ok: true, value: [euroBuy] });
  });

  it("refuses the WHOLE batch when one row has no rate", async () => {
    const result = await convertCapturedOperations(
      [usdBuy("2026-01-23", "8.00"), usdBuy("2019-07-04", "5.00")],
      { fetchDailyRates: async () => USD_SERIES },
    );

    expect(result).toEqual({
      ok: false,
      violations: [
        {
          code: "operation_currency_missing_rate",
          currency: "USD",
          executedAt: "2019-07-04",
        },
      ],
    });
  });

  it("degrades to a refusal, never to a 1:1 rate, when ECB is down", async () => {
    const result = await convertCapturedOperations([usdBuy("2026-01-23", "8.00")], {
      fetchDailyRates: async () => new Map(),
    });

    expect(result.ok).toBe(false);
  });
});

describe("convertCapturedOperation", () => {
  it("converts the single apunte of the operations form", async () => {
    const result = await convertCapturedOperation(usdBuy("2026-01-23", "8.00"), {
      fetchDailyRates: async () => USD_SERIES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe("EUR");
    expect(result.value.pricePerUnit).toBe("6.8");
    expect(result.value.capture?.currency).toBe("USD");
  });
});

describe("convertStatementRows", () => {
  const row = (dateKey: string, currency: string, pricePerUnit: string) =>
    ({
      currency,
      dateKey,
      feesMinor: 0,
      isin: "IE00BDZVHT63",
      kind: "buy" as const,
      pricePerUnit,
      units: "1",
    }) as const;

  it("converts a dollar row and keeps what the file stated", async () => {
    const result = await convertStatementRows([row("2026-01-23", "USD", "8.00")], {
      fetchDailyRates: async () => USD_SERIES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.currency).toBe("EUR");
    expect(result.value[0]?.pricePerUnit).toBe("6.8");
    expect(result.value[0]?.capture).toEqual({
      currency: "USD",
      eurPerUnit: 0.85,
      feesMinor: 0,
      pricePerUnit: "8.00",
    });
  });

  it("leaves a euro-only file byte for byte, with no request", async () => {
    let fetched = false;
    const rows = [row("2026-01-23", "EUR", "8.00")];

    const result = await convertStatementRows(rows, {
      fetchDailyRates: async () => {
        fetched = true;
        return USD_SERIES;
      },
    });

    expect(fetched).toBe(false);
    expect(result).toEqual({ ok: true, value: rows });
  });

  it("refuses the whole file when one row has no rate", async () => {
    const result = await convertStatementRows(
      [row("2026-01-23", "USD", "8.00"), row("2019-07-04", "USD", "5.00")],
      { fetchDailyRates: async () => USD_SERIES },
    );

    expect(result.ok).toBe(false);
  });
});
