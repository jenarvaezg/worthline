import { describe, expect, test } from "vitest";

import { chunk } from "./chunk";

describe("chunk", () => {
  test("splits into fixed-size groups, last one short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("keeps a list shorter than the size in one chunk, and an empty list empty", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
    expect(chunk([], 10)).toEqual([]);
  });

  test("rejects a size below one rather than looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(/at least 1/);
  });
});
