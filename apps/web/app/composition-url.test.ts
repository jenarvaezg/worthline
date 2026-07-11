import { describe, expect, test } from "vitest";

import { compositionUrl } from "./composition-url";

describe("compositionUrl", () => {
  test("builds dashboard URLs under /app", () => {
    expect(compositionUrl("total", "liquid", "1y", "visible")).toBe(
      "/app?drill=liquid&range=1y#composicion",
    );
  });

  test("threads the liquid framing param", () => {
    expect(compositionUrl("liquid", "debts", "3y", "visible", false)).toBe(
      "/app?view=liquid&drill=debts&range=3y",
    );
  });
});
