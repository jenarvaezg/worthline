import { describe, expect, test } from "vitest";

import {
  myInvestorGroupState,
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

  test("the group box is all, none or mixed", () => {
    expect(myInvestorGroupState(["a", "b"], new Set(["a", "b"]))).toBe("all");
    expect(myInvestorGroupState(["a", "b"], new Set(["a"]))).toBe("mixed");
    expect(myInvestorGroupState(["a", "b"], new Set())).toBe("none");
    expect(myInvestorGroupState([], new Set(["a"]))).toBe("none");
  });
});
