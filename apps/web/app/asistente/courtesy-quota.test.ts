import { describe, expect, it } from "vitest";

import {
  courtesyMonthWindow,
  FREE_ASSISTANT_MONTHLY_QUOTA,
  isCourtesyQuotaExhausted,
} from "./courtesy-quota";

describe("courtesyMonthWindow", () => {
  it("buckets an ISO timestamp into its YYYY-MM month", () => {
    expect(courtesyMonthWindow("2026-07-22T10:00:00.000Z")).toBe("2026-07");
    expect(courtesyMonthWindow("2026-12-31T23:59:59.000Z")).toBe("2026-12");
  });
});

describe("isCourtesyQuotaExhausted", () => {
  it("permits counts up to and including the quota", () => {
    expect(isCourtesyQuotaExhausted(1)).toBe(false);
    expect(isCourtesyQuotaExhausted(FREE_ASSISTANT_MONTHLY_QUOTA)).toBe(false);
  });

  it("blocks once the running count exceeds the quota", () => {
    expect(isCourtesyQuotaExhausted(FREE_ASSISTANT_MONTHLY_QUOTA + 1)).toBe(true);
  });

  it("treats an unmetered (null) count as never exhausted", () => {
    expect(isCourtesyQuotaExhausted(null)).toBe(false);
  });
});
