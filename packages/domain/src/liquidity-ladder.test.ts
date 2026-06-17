import { describe, expect, test } from "vitest";

import type { LiquidityTier } from "./liquidity-ladder";
import { isLiquid, LIQUIDITY_LADDER, rungForLiability } from "./liquidity-ladder";

describe("liquidity ladder", () => {
  test("rungs are ordered most to least liquid, ending in housing", () => {
    expect(LIQUIDITY_LADDER).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
  });

  test("isLiquid is true only for the top two rungs (cash, market)", () => {
    expect(isLiquid("cash")).toBe(true);
    expect(isLiquid("market")).toBe(true);
    expect(isLiquid("term-locked")).toBe(false);
    expect(isLiquid("illiquid")).toBe(false);
    expect(isLiquid("housing")).toBe(false);
  });
});

describe("rungForLiability", () => {
  const assetRungById = new Map<string, LiquidityTier>([
    ["asset_home", "illiquid"],
    ["asset_broker", "market"],
  ]);

  test("an associated liability inherits its asset's rung (a mortgage nets against its house on illiquid)", () => {
    expect(rungForLiability({ associatedAssetId: "asset_home" }, assetRungById)).toBe(
      "illiquid",
    );
    expect(rungForLiability({ associatedAssetId: "asset_broker" }, assetRungById)).toBe(
      "market",
    );
  });

  test("an unassociated liability lands on cash", () => {
    expect(rungForLiability({}, assetRungById)).toBe("cash");
  });

  test("an associated liability whose asset is unknown falls back to cash", () => {
    expect(rungForLiability({ associatedAssetId: "ghost" }, assetRungById)).toBe("cash");
  });
});
