/**
 * Benchmark-series hygiene in the control plane (#1354).
 *
 * Stooq's anti-bot challenge page was parsed as CSV and persisted: every
 * market-index series ended up with a single row keyed `date = "(async(-01"`,
 * and the «vs índice» lens read it as a real data point from 2026-07-10 onwards.
 * Two guarantees are pinned here against a real (file-backed) database:
 *
 *   1. The MIGRATION ladder purges rows whose `date` is not a real day key, so
 *      the cron's benchmark phase can re-ingest the true monthly history (it only
 *      writes months the cache lacks — without the purge nothing would backfill).
 *   2. The WRITE boundary refuses a malformed point, so no future provider can
 *      poison the table the same way.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneStore } from "@db/control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
  writeControlPlaneSchemaVersion,
} from "@db/control-plane/migrate";
import { openLibsqlClient } from "@db/libsql-client";
import { afterAll, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

function tempDbUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), "worthline-cp-benchmark-"));
  tempDirs.push(dir);
  return `file:${join(dir, "control-plane.sqlite")}`;
}

describe("control-plane benchmark purge migration", () => {
  test("a pre-v7 control plane loses its malformed rows and keeps the real ones", async () => {
    const url = tempDbUrl();
    const legacy = openLibsqlClient({ url });
    await legacy.execute(`CREATE TABLE IF NOT EXISTS benchmark_prices (
      series_id TEXT NOT NULL,
      date TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (series_id, date)
    )`);
    // The exact production shape: one poisoned row per Stooq series, plus a
    // healthy INE CPI series that must survive untouched.
    for (const [seriesId, date, value] of [
      ["sp500-price", "(async(-01", "0"],
      ["msci-world-tr", "(async(-01", "0"],
      ["ipc-es", "2026-05-01", "116.4"],
      ["ipc-es", "2026-06-01", "116.9"],
    ] as const) {
      await legacy.execute({
        sql: "INSERT INTO benchmark_prices (series_id, date, value) VALUES (?, ?, ?)",
        args: [seriesId, date, value],
      });
    }
    await writeControlPlaneSchemaVersion(legacy, 6);

    await migrateControlPlane(legacy);

    expect(await readControlPlaneSchemaVersion(legacy)).toBe(CP_SCHEMA_VERSION);
    expect(CP_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const remaining = await legacy.execute(
      "SELECT series_id, date FROM benchmark_prices ORDER BY series_id, date",
    );
    expect(
      remaining.rows.map((row) => [String(row["series_id"]), String(row["date"])]),
    ).toEqual([
      ["ipc-es", "2026-05-01"],
      ["ipc-es", "2026-06-01"],
    ]);

    legacy.close();
  });

  test("migrating a control plane with no benchmark table at all does not throw", async () => {
    const url = tempDbUrl();
    const legacy = openLibsqlClient({ url });
    await writeControlPlaneSchemaVersion(legacy, 6);

    await expect(migrateControlPlane(legacy)).resolves.toBeUndefined();

    legacy.close();
  });
});

describe("benchmark write boundary", () => {
  test("refuses a point whose date is not a real day key, and one with a bad value", async () => {
    const cp = await createControlPlaneStore({ url: tempDbUrl() });
    try {
      await cp.upsertBenchmarkPrices("sp500-price", [
        { dateKey: "(async(-01", value: "0" },
        { dateKey: "2026-13-01", value: "100" },
        { dateKey: "2026-06-01", value: "not-a-number" },
        { dateKey: "2026-06-01", value: "0" },
        { dateKey: "2026-06-01", value: "6300.25" },
      ]);

      expect(await cp.readBenchmarkPrices("sp500-price")).toEqual([
        { seriesId: "sp500-price", dateKey: "2026-06-01", value: "6300.25" },
      ]);
    } finally {
      cp.close();
    }
  });
});
