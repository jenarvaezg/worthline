import { describe, expect, test } from "vitest";

import {
  deriveConfirmedMonthlyCloseIds,
  deriveMonthlyCloses,
  findTodaySnapshotId,
} from "./snapshot-policy";

// Minimal snapshot shape — only the fields the policy cares about.
function snap(id: string, dateKey: string, scopeId = "household") {
  return { id, dateKey, monthKey: dateKey.slice(0, 7), scopeId };
}

describe("findTodaySnapshotId", () => {
  test("returns undefined when there are no existing snapshots", () => {
    expect(findTodaySnapshotId([], "household", "2026-06-09")).toBeUndefined();
  });

  test("returns undefined when no snapshot exists for today in this scope", () => {
    const existing = [snap("s1", "2026-06-08")];
    expect(findTodaySnapshotId(existing, "household", "2026-06-09")).toBeUndefined();
  });

  test("returns the existing snapshot id when one exists for today (latest wins)", () => {
    const existing = [snap("s1", "2026-06-09")];
    expect(findTodaySnapshotId(existing, "household", "2026-06-09")).toBe("s1");
  });

  test("picks today's snapshot even when older same-scope snapshots exist", () => {
    const existing = [snap("s1", "2026-06-09"), snap("s2", "2026-06-08")];
    expect(findTodaySnapshotId(existing, "household", "2026-06-09")).toBe("s1");
  });

  test("ignores snapshots from other scopes when checking today", () => {
    const existing = [snap("s1", "2026-06-09", "member_jose")];
    expect(findTodaySnapshotId(existing, "household", "2026-06-09")).toBeUndefined();
  });

  test("handles empty history — no errors on empty array", () => {
    expect(() => findTodaySnapshotId([], "household", "2026-06-09")).not.toThrow();
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
    const snapshots = [snap("s1", "2025-12-31"), snap("s2", "2026-01-01")];
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

describe("deriveConfirmedMonthlyCloseIds", () => {
  test("confirms the close of a fully elapsed month", () => {
    const snapshots = [snap("may", "2026-05-20"), snap("jun", "2026-06-10")];
    const closes = deriveConfirmedMonthlyCloseIds(snapshots, "2026-06-10");

    // May has fully elapsed by 10 Jun, so its last snapshot is a real close
    // even though it does not fall on the last calendar day.
    expect(closes.has("may")).toBe(true);
  });

  test("does NOT confirm the in-progress month's trailing snapshot mid-month (#270)", () => {
    const snapshots = [snap("may", "2026-05-20"), snap("today", "2026-06-10")];
    const closes = deriveConfirmedMonthlyCloseIds(snapshots, "2026-06-10");

    // June is still running on the 10th — today is the latest capture, not a close.
    expect(closes.has("today")).toBe(false);
  });

  test("confirms the in-progress month's snapshot when it lands on month-end", () => {
    const snapshots = [snap("today", "2026-06-30")];
    const closes = deriveConfirmedMonthlyCloseIds(snapshots, "2026-06-30");

    // The last calendar day of June IS a real close, even though June is "current".
    expect(closes.has("today")).toBe(true);
  });

  test("confirms the LAST snapshot of an elapsed month, not a middle one", () => {
    const snapshots = [
      snap("early", "2026-05-02"),
      snap("late", "2026-05-28"),
      snap("now", "2026-06-05"),
    ];
    const closes = deriveConfirmedMonthlyCloseIds(snapshots, "2026-06-05");

    expect(closes.has("late")).toBe(true);
    expect(closes.has("early")).toBe(false);
  });

  test("empty snapshots → empty set", () => {
    expect(deriveConfirmedMonthlyCloseIds([], "2026-06-10").size).toBe(0);
  });

  test("confirms December's close once the year has turned", () => {
    const snapshots = [snap("dec", "2025-12-20"), snap("jan", "2026-01-04")];
    const closes = deriveConfirmedMonthlyCloseIds(snapshots, "2026-01-04");

    expect(closes.has("dec")).toBe(true);
    expect(closes.has("jan")).toBe(false);
  });
});
