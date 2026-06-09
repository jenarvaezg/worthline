import { describe, expect, test } from "vitest";

import {
  deriveMonthlyCloses,
  planSnapshotCapture,
} from "./snapshot-policy";

// Minimal snapshot shape — only the fields the policy cares about.
function snap(id: string, dateKey: string, scopeId = "household") {
  return { id, dateKey, monthKey: dateKey.slice(0, 7), scopeId };
}

describe("planSnapshotCapture", () => {
  test("captures when there are no existing snapshots", () => {
    const result = planSnapshotCapture([], "household", "2026-06-09");

    expect(result.shouldCapture).toBe(true);
    expect(result.replacesId).toBeUndefined();
  });

  test("captures when no snapshot exists for today in this scope", () => {
    const existing = [snap("s1", "2026-06-08")];
    const result = planSnapshotCapture(existing, "household", "2026-06-09");

    expect(result.shouldCapture).toBe(true);
    expect(result.replacesId).toBeUndefined();
  });

  test("replaces when a snapshot already exists for today in this scope (latest wins)", () => {
    const existing = [snap("s1", "2026-06-09")];
    const result = planSnapshotCapture(existing, "household", "2026-06-09");

    expect(result.shouldCapture).toBe(true);
    expect(result.replacesId).toBe("s1");
  });

  test("does not capture again when there is already one today and it is still the same scope", () => {
    // Same-day re-open scenario: existing snapshot from this morning for the scope.
    // The caller may decide to skip capture altogether or replace — we always say replace.
    const existing = [snap("s1", "2026-06-09"), snap("s2", "2026-06-08")];
    const result = planSnapshotCapture(existing, "household", "2026-06-09");

    expect(result.shouldCapture).toBe(true);
    expect(result.replacesId).toBe("s1");
  });

  test("ignores snapshots from other scopes when checking today", () => {
    const existing = [snap("s1", "2026-06-09", "member_jose")];
    const result = planSnapshotCapture(existing, "household", "2026-06-09");

    expect(result.shouldCapture).toBe(true);
    expect(result.replacesId).toBeUndefined();
  });

  test("handles empty history — no errors on empty array", () => {
    expect(() => planSnapshotCapture([], "household", "2026-06-09")).not.toThrow();
  });
});

describe("deriveMonthlyCloses", () => {
  test("returns empty map for empty snapshots", () => {
    const closes = deriveMonthlyCloses([]);

    expect(closes.size).toBe(0);
  });

  test("single snapshot is its own month close", () => {
    const snapshots = [snap("s1", "2026-06-09")];
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2026-06")).toBe("s1");
  });

  test("last snapshot of the month wins", () => {
    const snapshots = [snap("s1", "2026-06-01"), snap("s2", "2026-06-30")];
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2026-06")).toBe("s2");
  });

  test("each month has its own close", () => {
    const snapshots = [
      snap("s1", "2026-05-31"),
      snap("s2", "2026-06-01"),
      snap("s3", "2026-06-30"),
      snap("s4", "2026-07-01"),
    ];
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2026-05")).toBe("s1");
    expect(closes.get("2026-06")).toBe("s3");
    expect(closes.get("2026-07")).toBe("s4");
  });

  test("handles year boundary correctly", () => {
    const snapshots = [
      snap("s1", "2025-12-31"),
      snap("s2", "2026-01-01"),
    ];
    const closes = deriveMonthlyCloses(snapshots);

    expect(closes.get("2025-12")).toBe("s1");
    expect(closes.get("2026-01")).toBe("s2");
  });

  test("isolates closes per scope", () => {
    const snapshots = [
      snap("s1", "2026-06-09", "household"),
      snap("s2", "2026-06-10", "member_jose"),
    ];
    const closesHousehold = deriveMonthlyCloses(
      snapshots.filter((s) => s.scopeId === "household"),
    );
    const closesJose = deriveMonthlyCloses(
      snapshots.filter((s) => s.scopeId === "member_jose"),
    );

    expect(closesHousehold.get("2026-06")).toBe("s1");
    expect(closesJose.get("2026-06")).toBe("s2");
  });

  test("middle snapshot is NOT a monthly close when a later one exists in same month", () => {
    const snapshots = [
      snap("s1", "2026-06-01"),
      snap("s2", "2026-06-15"),
      snap("s3", "2026-06-30"),
    ];
    const closes = deriveMonthlyCloses(snapshots);

    // Only the last one is the close.
    expect(closes.get("2026-06")).toBe("s3");
    expect([...closes.values()]).not.toContain("s1");
    expect([...closes.values()]).not.toContain("s2");
  });
});
