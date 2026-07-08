import type { BenchmarkPricePoint } from "./ine-cpi";

/**
 * Fetch monthly benchmark prices from Stooq (ADR 0060, #625). Uses the monthly
 * interval (`i=m`) so the control-plane cache stores one row per month — the
 * same shape as INE CPI. Dates are normalized to the first of the month for
 * alignment with the benchmark-comparison month-key matcher.
 */
export async function fetchStooqMonthlyBenchmark(
  symbol: string,
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<BenchmarkPricePoint[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = "https://stooq.com/q/d/l/?s=" + encodeURIComponent(symbol) + "&i=m";
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Stooq responded with ${res.status}`);
  }

  const lines = (await res.text()).trim().split("\n");
  if (lines.length < 2) {
    return [];
  }

  const points: BenchmarkPricePoint[] = [];
  for (const rawLine of lines.slice(1)) {
    const parts = rawLine.split(",");
    const date = (parts[0] ?? "").trim();
    const close = (parts[4] ?? "").trim();
    if (!date || !close || close === "N/D") continue;

    const monthKey = date.slice(0, 7);
    points.push({ dateKey: `${monthKey}-01`, value: close });
  }

  return points.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}
