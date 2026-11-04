import { describe, expect, test } from "vitest";

import {
  myInvestorGroupState,
  parseMyInvestorInclusionForm,
  setMyInvestorSelection,
  toggleMyInvestorSelection,
} from "./myinvestor-selection";

describe("the choice of the first start (#1880)", () => {
  test("a box ticks and unticks one product, never touching the old choice", () => {
    const before = new Set(["a"]);
    const after = toggleMyInvestorSelection(before, "b");
    expect([...after].sort()).toEqual(["a", "b"]);
    expect([...toggleMyInvestorSelection(after, "a")]).toEqual(["b"]);
    expect([...before]).toEqual(["a"]);
  });

  test("a group box ticks or unticks the whole group", () => {
    const picked = setMyInvestorSelection(new Set(["x"]), ["a", "b"], true);
    expect([...picked].sort()).toEqual(["a", "b", "x"]);
    expect([...setMyInvestorSelection(picked, ["a", "b"], false)]).toEqual(["x"]);
  });

  test("the form reads back the boxes, and each twin as a link, a new holding or nothing (#1881)", () => {
    expect(
      parseMyInvestorInclusionForm([
        ["productKey", "cash:1"],
        ["twin:securities:1|isin:A", "link:asset_hand"],
        ["twin:securities:1|isin:B", "separate"],
        ["twin:securities:1|isin:C", "skip"],
        ["twin:securities:1|isin:D", "whatever"],
        ["sourceId", "src"],
      ]),
    ).toEqual({
      links: [{ assetId: "asset_hand", productKey: "securities:1|isin:A" }],
      productKeys: ["cash:1", "securities:1|isin:B"],
    });
  });

  test("the group box is all, none or mixed", () => {
    expect(myInvestorGroupState(["a", "b"], new Set(["a", "b"]))).toBe("all");
    expect(myInvestorGroupState(["a", "b"], new Set(["a"]))).toBe("mixed");
    expect(myInvestorGroupState(["a", "b"], new Set())).toBe("none");
    expect(myInvestorGroupState([], new Set(["a"]))).toBe("none");
  });
});
