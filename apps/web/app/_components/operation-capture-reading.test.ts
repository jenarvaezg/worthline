import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { readOperationFees, readOperationPrice } from "./operation-capture-reading";

function op(overrides: Partial<InvestmentOperation> = {}): InvestmentOperation {
  return {
    assetId: "fidelity",
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

describe("readOperationPrice", () => {
  test("a euro operation reads as one figure, with nothing to add", () => {
    expect(readOperationPrice(op(), false)).toEqual({ capture: null, price: "6.8" });
  });

  test("a converted operation shows the euros AND what the bank stated", () => {
    const reading = readOperationPrice(
      op({
        capture: {
          currency: "USD",
          eurPerUnit: 0.85,
          feesMinor: 0,
          pricePerUnit: "8.00",
        },
      }),
      false,
    );

    expect(reading).toEqual({ capture: "8.00 USD", price: "6.8" });
  });

  test("an optimistic row still in its own currency says so instead of lying", () => {
    // The row the island adds before the redirect: the typed price, in the typed
    // currency, with no rate known yet — so it must not be read as euros.
    const reading = readOperationPrice(
      op({ currency: "USD", pricePerUnit: "8.00" }),
      false,
    );

    expect(reading).toEqual({ capture: null, price: "8.00 USD" });
  });

  test("privacy mode masks both figures", () => {
    const reading = readOperationPrice(
      op({
        capture: {
          currency: "USD",
          eurPerUnit: 0.85,
          feesMinor: 0,
          pricePerUnit: "8.00",
        },
      }),
      true,
    );

    expect(reading.price).not.toContain("6");
    expect(reading.capture).not.toContain("8");
    expect(reading.capture).toContain("USD");
  });
});

describe("readOperationFees", () => {
  const usdCapture = {
    currency: "USD",
    eurPerUnit: 0.85,
    feesMinor: 150,
    pricePerUnit: "8.00",
  };

  test("no fees at all reads as nothing to show", () => {
    expect(readOperationFees(op(), false)).toBeNull();
  });

  test("euro fees read as one figure", () => {
    const reading = readOperationFees(op({ feesMinor: 128 }), false);

    expect(reading?.fees).toEqual({ amountMinor: 128, currency: "EUR" });
    expect(reading?.capture).toBeNull();
  });

  test("converted fees show the euros AND what the bank charged", () => {
    const reading = readOperationFees(op({ capture: usdCapture, feesMinor: 128 }), false);

    expect(reading?.fees).toEqual({ amountMinor: 128, currency: "EUR" });
    expect(reading?.capture).toContain("US$");
  });

  test("a converted operation with no fees still shows nothing", () => {
    const reading = readOperationFees(
      op({ capture: { ...usdCapture, feesMinor: 0 }, feesMinor: 0 }),
      false,
    );

    expect(reading).toBeNull();
  });
});
