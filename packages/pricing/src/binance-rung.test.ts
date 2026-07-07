import { describe, expect, test } from "vitest";

import { rungForWallet } from "./binance-rung";

describe("rungForWallet", () => {
  test("spot, funding and flexible Earn are market-liquid", () => {
    for (const wallet of ["spot", "funding", "flexible-earn"]) {
      expect(rungForWallet(wallet)).toBe("market");
    }
  });

  test("locked Earn and staking are term-locked", () => {
    for (const wallet of ["locked-earn", "staking"]) {
      expect(rungForWallet(wallet)).toBe("term-locked");
    }
  });

  test("an unforeseen wallet defaults to market", () => {
    expect(rungForWallet("mystery")).toBe("market");
  });
});
