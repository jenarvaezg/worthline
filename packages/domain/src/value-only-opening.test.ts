import { describe, expect, test } from "vitest";
import type { DecimalString, InvestmentOperation } from "./index";
import {
  detectValueOnlyOpening,
  valueOnlySymbolFormNotice,
  valueOnlySymbolGuardMessage,
} from "./value-only-opening";

/** Intl separates the amount from the € with a non-breaking space. */
function plain(text: string): string {
  return text.replace(/\s/g, " ");
}

function op(overrides: Partial<InvestmentOperation> = {}): InvestmentOperation {
  return {
    assetId: "asset_fund",
    currency: "EUR",
    executedAt: "2026-07-28",
    feesMinor: 0,
    id: "op_opening",
    kind: "buy",
    pricePerUnit: "574.48" as DecimalString,
    source: "opening",
    units: "1" as DecimalString,
    ...overrides,
  };
}

describe("detectValueOnlyOpening (#1329)", () => {
  test("the lone 1-participación opening BUY is the value-only encoding", () => {
    expect(detectValueOnlyOpening([op()])).toEqual({
      pricePerUnit: "574.48",
      valueMinor: 574_48,
    });
  });

  test("a curated ledger (second operation) is none of the guard's business", () => {
    expect(
      detectValueOnlyOpening([
        op(),
        op({ id: "op_2", source: "manual", units: "3" as DecimalString }),
      ]),
    ).toBeNull();
  });

  test("a hand-recorded 1-unit buy is a real share, not an alta's placeholder", () => {
    expect(detectValueOnlyOpening([op({ source: "manual" })])).toBeNull();
  });

  test("an opening with real units derived from a price is not value-only", () => {
    expect(
      detectValueOnlyOpening([op({ units: "3.01814849" as DecimalString })]),
    ).toBeNull();
  });

  test("an empty ledger has nothing to protect", () => {
    expect(detectValueOnlyOpening([])).toBeNull();
  });
});

describe("valueOnlySymbolGuardMessage (#1329)", () => {
  const opening = { pricePerUnit: "574.48" as DecimalString, valueMinor: 574_48 };

  test("names both figures when the quote is known — the loss is the point", () => {
    const message = plain(
      valueOnlySymbolGuardMessage({
        opening,
        quotedPricePerUnit: "11.90",
        symbol: "SAN.MC",
      }),
    );

    expect(message).toContain("574,48 €");
    expect(message).toContain("11,90 €");
    expect(message).toContain("SAN.MC");
    expect(message).toContain("Es una participación real");
  });

  test("stays honest with no quote in hand (Finect / CoinGecko save path)", () => {
    const message = plain(
      valueOnlySymbolGuardMessage({
        opening,
        quotedPricePerUnit: null,
        symbol: "N5394",
      }),
    );

    expect(message).toContain("574,48 €");
    expect(message).toContain("UNA participación de «N5394»");
  });

  test("an unreadable quote never becomes an invented figure", () => {
    const message = plain(
      valueOnlySymbolGuardMessage({
        opening,
        quotedPricePerUnit: "1.2e-8",
        symbol: "SHIB",
      }),
    );

    expect(message).toContain("UNA participación");
    expect(message).not.toContain("0,00 €");
  });

  test("the form notice states the same value before anything is submitted", () => {
    expect(plain(valueOnlySymbolFormNotice(opening))).toContain("574,48 €");
  });
});
