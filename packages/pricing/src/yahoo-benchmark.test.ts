import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchYahooMonthlyBenchmark } from "./yahoo-benchmark";

/** A Yahoo monthly chart body with one close per timestamp. */
function chart(points: Array<[number, number | null]>): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { currency: "EUR" },
          timestamp: points.map(([ts]) => ts),
          indicators: { quote: [{ close: points.map(([, close]) => close) }] },
        },
      ],
      error: null,
    },
  });
}

const JAN_2024 = Date.UTC(2024, 0, 1) / 1000;
const FEB_2024 = Date.UTC(2024, 1, 1) / 1000;

describe("fetchYahooMonthlyBenchmark", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches monthly Yahoo history and normalizes dates to month starts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        chart([
          [JAN_2024, 91.5],
          [FEB_2024, 94.2],
        ]),
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).resolves.toEqual([
      { dateKey: "2024-01-01", value: "91.5" },
      { dateKey: "2024-02-01", value: "94.2" },
    ]);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
      "https://query2.finance.yahoo.com/v8/finance/chart/EUNL.DE?interval=1mo&range=10y",
    );
  });

  test("encodes symbols that carry chart-hostile characters (^GSPC, GC=F)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => chart([[JAN_2024, 1]]),
    } as Response);

    await fetchYahooMonthlyBenchmark("^GSPC");
    await fetchYahooMonthlyBenchmark("GC=F");

    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("chart/%5EGSPC?");
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain("chart/GC%3DF?");
  });

  test("skips months without a usable close instead of inventing one", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        chart([
          [JAN_2024, null],
          [FEB_2024, 94.2],
        ]),
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).resolves.toEqual([
      { dateKey: "2024-02-01", value: "94.2" },
    ]);
  });

  test("rejects non-positive and non-finite closes (a benchmark never reads 0)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        chart([
          [JAN_2024, 0],
          [FEB_2024, Number.NaN],
        ]),
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).resolves.toEqual([]);
  });

  test("throws on an HTTP error so the cron records the series as failed", async () => {
    // A persistent stub: 429 is transient, so the shared retry (#1694) spends its
    // three attempts first. The series still fails loudly — never an empty row set.
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("an HTML anti-bot page is a failure, never a parsed row (#1354)", async () => {
    // The exact failure mode that poisoned `benchmark_prices` with a row dated
    // "(async(-01": a challenge page accepted as data. It cannot become a row —
    // and it must not pass as an empty series either, or the miss goes unseen.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        "<!DOCTYPE html><html><script>(async()=>{})()</script>This site requires JavaScript",
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).rejects.toThrow(/non-JSON/);
  });

  test("an unknown symbol (no chart result) fails loudly, so the cron records it", async () => {
    // A mistyped catalog symbol must not read as "this series has no data": that
    // would leave it permanently empty with nothing reported anywhere.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          chart: { result: null, error: { code: "Not Found" } },
        }),
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("^MXWO")).rejects.toThrow(/no chart result/);
  });

  test("keeps the last close when a month appears twice, and sorts ascending", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        chart([
          [FEB_2024, 94.2],
          [JAN_2024, 90],
          [JAN_2024 + 86_400 * 15, 91.5],
        ]),
    } as Response);

    await expect(fetchYahooMonthlyBenchmark("EUNL.DE")).resolves.toEqual([
      { dateKey: "2024-01-01", value: "91.5" },
      { dateKey: "2024-02-01", value: "94.2" },
    ]);
  });
});
