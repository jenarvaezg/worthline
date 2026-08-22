import { describe, expect, test } from "vitest";

import { storeOpenLabel } from "./perf-log";

describe("storeOpenLabel", () => {
  test("appends the route so each page is greppable (#1538)", () => {
    expect(storeOpenLabel(false, "/historico")).toBe("store-open:/historico");
    expect(storeOpenLabel(true, "/historico")).toBe("store-open:cold:/historico");
  });

  test("falls back to the work-unit name when the path is unknown", () => {
    expect(storeOpenLabel(false)).toBe("store-open");
    expect(storeOpenLabel(true)).toBe("store-open:cold");
  });
});
