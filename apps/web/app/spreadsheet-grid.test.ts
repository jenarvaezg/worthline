import { describe, expect, test } from "vitest";

import { toIsoDate } from "./spreadsheet-grid";

describe("toIsoDate", () => {
  test("reformats dd/mm/yyyy and rejects an impossible day", () => {
    expect(toIsoDate("15/01/2026")).toBe("2026-01-15");
    expect(toIsoDate("5/1/2026")).toBe("2026-01-05");
    expect(toIsoDate("2026-01-15")).toBe("2026-01-15");
    expect(toIsoDate("32/13/2026")).toBeNull();
    expect(toIsoDate("30 de junio")).toBeNull();
  });
});
