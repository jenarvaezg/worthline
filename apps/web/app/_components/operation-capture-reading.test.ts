import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { readOperationPrice } from "./operation-capture-reading";

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
