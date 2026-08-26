import type { Client } from "@libsql/client";
import { isPositiveDecimal } from "@worthline/domain";

/** The table owned by the benchmark-series port (ADR 0060). */
export const BENCHMARK_PRICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS benchmark_prices (
  series_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, date)
);
`;

export interface BenchmarkPrice {
  seriesId: string;
  dateKey: string;
  value: string;
}

/** Benchmark series cached globally in the control plane (ADR 0060). */
export interface BenchmarkPriceCache {
  readBenchmarkPrices(seriesId: string): Promise<BenchmarkPrice[]>;
  /** Upsert monthly benchmark rows by `(series_id, date)`. */
  upsertBenchmarkPrices(
    seriesId: string,
    prices: { dateKey: string; value: string }[],
  ): Promise<void>;
}

function toBenchmarkPrice(row: Record<string, unknown>): BenchmarkPrice {
  return {
    seriesId: String(row["series_id"]),
    dateKey: String(row["date"]),
    value: String(row["value"]),
  };
}

/** A benchmark row's date must be a real `YYYY-MM-DD` day key (#1354). */
function isBenchmarkDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed);
}

export function createBenchmarkPriceCache(client: Client): BenchmarkPriceCache {
  return {
    async readBenchmarkPrices(seriesId) {
      const result = await client.execute({
        sql: `SELECT series_id, date, value
              FROM benchmark_prices
              WHERE series_id = ?
              ORDER BY date ASC`,
        args: [seriesId],
      });
      return result.rows.map((row) => toBenchmarkPrice(row));
    },
    async upsertBenchmarkPrices(seriesId, prices) {
      for (const price of prices) {
        // Shape guard at the write boundary (#1354): a series row must be a real
        // day key and a finite positive number. This table once stored a row
        // keyed `"(async(-01"` — an anti-bot page that a CSV parser had split by
        // commas — and it fed the «vs índice» lens for weeks. Whatever a future
        // provider hands us, a malformed point is dropped here rather than
        // persisted as data.
        if (!isBenchmarkDateKey(price.dateKey) || !isPositiveDecimal(price.value)) {
          continue;
        }
        await client.execute({
          sql: `INSERT INTO benchmark_prices (series_id, date, value)
                VALUES (?, ?, ?)
                ON CONFLICT(series_id, date) DO UPDATE SET
                  value = excluded.value,
                  updated_at = CURRENT_TIMESTAMP`,
          args: [seriesId, price.dateKey, price.value],
        });
      }
    },
  };
}
