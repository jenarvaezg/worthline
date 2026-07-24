/**
 * Unit tests for the pure Numista connect/sync helpers (PRD #160 / #163):
 * ownership resolution, credential shaping, and last-sync formatting. No store,
 * no network — these are the decisions the thin server actions delegate to.
 */

import type { Member } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  formatLastSync,
  normalizeApiKey,
  readApiKey,
  resolveConnectingOwnership,
} from "./numista-helpers";

const members: Member[] = [
  { id: "mJ", name: "Jose" },
  { id: "mA", name: "Ana" },
  { id: "mOld", name: "Inactivo", disabledAt: "2026-01-01T00:00:00.000Z" },
];

describe("resolveConnectingOwnership", () => {
  test("100 % to the cookie-scope member when it maps to an active member", () => {
    expect(resolveConnectingOwnership(members, "mA")).toEqual([
      { memberId: "mA", shareBps: 10_000 },
    ]);
  });

  test("falls back to the first active member when the scope does not map", () => {
    expect(resolveConnectingOwnership(members, "household")).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
    expect(resolveConnectingOwnership(members, undefined)).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
  });

  test("never resolves to a disabled member", () => {
    expect(resolveConnectingOwnership(members, "mOld")).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
  });

  test("returns null when there is no active member", () => {
    expect(
      resolveConnectingOwnership(
        [{ id: "x", name: "X", disabledAt: "2026-01-01T00:00:00.000Z" }],
        undefined,
      ),
    ).toBeNull();
  });
});

describe("normalizeApiKey", () => {
  test("trims and rejects a blank key", () => {
    expect(normalizeApiKey("  abc123 ")).toBe("abc123");
    expect(normalizeApiKey("   ")).toBeNull();
    expect(normalizeApiKey(null)).toBeNull();
  });
});

describe("readApiKey", () => {
  test("reads the stored apiKey back out of the credentials JSON", () => {
    expect(readApiKey('{"apiKey":"secret-key"}')).toBe("secret-key");
  });

  test("readApiKey returns null on malformed or empty credentials", () => {
    expect(readApiKey("not json")).toBeNull();
    expect(readApiKey('{"apiKey":""}')).toBeNull();
    expect(readApiKey("{}")).toBeNull();
  });
});

describe("formatLastSync", () => {
  test("a null or invalid stamp reads 'Nunca'", () => {
    expect(formatLastSync(null)).toBe("Nunca");
    expect(formatLastSync("not-a-date")).toBe("Nunca");
  });

  test("a valid ISO stamp renders an es-ES date-time", () => {
    const out = formatLastSync("2026-06-14T11:20:00.000Z");
    expect(out).not.toBe("Nunca");
    expect(out).toMatch(/2026/);
  });
});
