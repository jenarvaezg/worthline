import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchStooqMonthlyBenchmark } from "./stooq-benchmark";

describe("fetchStooqMonthlyBenchmark", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches monthly Stooq history and normalizes dates to month starts", async () => {
    const csv = [
      "Date,Open,High,Low,Close,Volume",
      "2024-01-31,90.00,92.00,89.00,91.50,1000",
      "2024-02-29,91.50,95.00,91.00,94.20,1200",
    ].join("\n");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    await expect(fetchStooqMonthlyBenchmark("eunl.de")).resolves.toEqual([
      { dateKey: "2024-01-01", value: "91.50" },
      { dateKey: "2024-02-01", value: "94.20" },
    ]);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
      "https://stooq.com/q/d/l/?s=eunl.de&i=m",
    );
  });

  test("skips rows without a parseable close", async () => {
    const csv = [
      "Date,Open,High,Low,Close,Volume",
      "2024-01-31,90.00,92.00,89.00,N/D,0",
      "2024-02-29,91.50,95.00,91.00,94.20,1200",
    ].join("\n");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csv,
    } as Response);

    await expect(fetchStooqMonthlyBenchmark("eunl.de")).resolves.toEqual([
      { dateKey: "2024-02-01", value: "94.20" },
    ]);
  });
});
