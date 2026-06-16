/**
 * Unit tests for the pure Binance connect/sync helpers (PRD #245, ADR 0021):
 * credential shaping + tolerant read-back. Ownership resolution and last-sync
 * formatting are re-exported from numista-helpers (covered there); this file
 * proves the re-export wiring plus the Binance-specific two-secret round-trip.
 * No store, no network — these are the decisions the thin server actions delegate.
 */

import { describe, expect, test } from "vitest";

import {
  buildBinanceCredentialsJson,
  formatLastSync,
  normalizeBinanceCredentials,
  readBinanceCredentials,
  resolveConnectingOwnership,
} from "./binance-helpers";

describe("normalizeBinanceCredentials", () => {
  test("trims and keeps both halves when present", () => {
    expect(normalizeBinanceCredentials("  key123 ", " secret456 ")).toEqual({
      apiKey: "key123",
      apiSecret: "secret456",
    });
  });

  test("rejects when either half is blank or missing", () => {
    expect(normalizeBinanceCredentials("key", "   ")).toBeNull();
    expect(normalizeBinanceCredentials("   ", "secret")).toBeNull();
    expect(normalizeBinanceCredentials(null, "secret")).toBeNull();
    expect(normalizeBinanceCredentials("key", null)).toBeNull();
    expect(normalizeBinanceCredentials(null, null)).toBeNull();
  });
});

describe("credentials round-trip", () => {
  test("buildBinanceCredentialsJson / readBinanceCredentials preserve both secrets", () => {
    const json = buildBinanceCredentialsJson("k", "s");
    expect(json).toBe('{"apiKey":"k","apiSecret":"s"}');
    expect(readBinanceCredentials(json)).toEqual({ apiKey: "k", apiSecret: "s" });
  });

  test("readBinanceCredentials returns null on malformed or partial credentials", () => {
    expect(readBinanceCredentials("not json")).toBeNull();
    expect(readBinanceCredentials('{"apiKey":"k"}')).toBeNull();
    expect(readBinanceCredentials('{"apiKey":"k","apiSecret":""}')).toBeNull();
    expect(readBinanceCredentials("{}")).toBeNull();
  });
});

describe("re-exported generic helpers", () => {
  test("resolveConnectingOwnership is the shared numista helper", () => {
    expect(resolveConnectingOwnership([{ id: "mJ", name: "Jose" }], undefined)).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
  });

  test("formatLastSync is the shared numista helper", () => {
    expect(formatLastSync(null)).toBe("Nunca");
    expect(formatLastSync("2026-06-16T11:20:00.000Z")).toMatch(/2026/);
  });
});
