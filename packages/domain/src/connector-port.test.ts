import { describe, expect, test } from "vitest";

import {
  assertCapability,
  type ConnectorAdapter,
  type NormalizedBatch,
  overlappingDateWindow,
  reconcileFacts,
  supportsCapability,
} from "./connector-port";

function fact(key: string, dateKey = "2026-01-01", payload: unknown = { key }) {
  return { key, dateKey, payload };
}

function batch(
  facts: ReturnType<typeof fact>[],
  cursor: string | null = "cursor-1",
): NormalizedBatch {
  return { facts, cursor };
}

describe("reconcileFacts", () => {
  test("tags every unseen fact as new and collects them to apply", () => {
    const plan = reconcileFacts(batch([fact("a"), fact("b")]), new Set());

    expect(plan.reconciled.map((r) => r.disposition)).toEqual(["new", "new"]);
    expect(plan.toApply.map((f) => f.key)).toEqual(["a", "b"]);
    expect(plan.cursor).toBe("cursor-1");
  });

  test("tags a fact already applied by a prior sync as duplicate and skips it", () => {
    const plan = reconcileFacts(batch([fact("a"), fact("b")]), new Set(["a"]));

    expect(plan.reconciled).toEqual([
      { fact: fact("a"), disposition: "duplicate" },
      { fact: fact("b"), disposition: "new" },
    ]);
    expect(plan.toApply.map((f) => f.key)).toEqual(["b"]);
  });

  test("deduplicates a key that repeats within the same batch (overlapping page)", () => {
    const plan = reconcileFacts(batch([fact("a"), fact("a"), fact("c")]), new Set());

    expect(plan.reconciled.map((r) => r.disposition)).toEqual([
      "new",
      "duplicate",
      "new",
    ]);
    expect(plan.toApply.map((f) => f.key)).toEqual(["a", "c"]);
  });

  test("an all-duplicate batch applies nothing but still carries the cursor forward", () => {
    const plan = reconcileFacts(batch([fact("a")], "cursor-9"), new Set(["a"]));

    expect(plan.toApply).toEqual([]);
    expect(plan.cursor).toBe("cursor-9");
  });

  test("does not mutate the caller's seen set", () => {
    const seen = new Set(["a"]);
    reconcileFacts(batch([fact("b")]), seen);
    expect([...seen]).toEqual(["a"]);
  });
});

describe("capabilities", () => {
  const adapter: Pick<ConnectorAdapter, "id" | "capabilities"> = {
    id: "reference",
    capabilities: [{ kind: "fetch_transactions" }, { kind: "disconnect" }],
  };

  test("supportsCapability reflects the declared set", () => {
    expect(supportsCapability(adapter, "fetch_transactions")).toBe(true);
    expect(supportsCapability(adapter, "discover_accounts")).toBe(false);
  });

  test("assertCapability throws a precise error for an undeclared capability", () => {
    expect(() => assertCapability(adapter, "fetch_positions")).toThrow(
      /reference does not support capability "fetch_positions"/,
    );
    expect(() => assertCapability(adapter, "disconnect")).not.toThrow();
  });
});

// ADR 0066 lets a source that settles late re-serve an overlap window instead of
// holding its cursor back; ADR 0114 (decision 5) fixes that overlap for MyInvestor.
describe("overlappingDateWindow", () => {
  const policy = { origin: "2000-01-01", overlapDays: 30 };

  test("the first sync reads from the origin up to today and resumes from today", () => {
    expect(overlappingDateWindow(null, "2026-07-19", policy)).toEqual({
      from: "2000-01-01",
      to: "2026-07-19",
      next: "2026-07-19",
    });
  });

  test("a later sync re-reads the overlap before the last good sync", () => {
    expect(overlappingDateWindow("2026-07-19", "2026-07-25", policy)).toEqual({
      from: "2026-06-19",
      to: "2026-07-25",
      next: "2026-07-25",
    });
  });

  test("the overlap crosses months and years on the calendar", () => {
    expect(overlappingDateWindow("2026-01-10", "2026-01-10", policy).from).toBe(
      "2025-12-11",
    );
  });

  test("never reads before the origin", () => {
    expect(overlappingDateWindow("2000-01-15", "2000-02-01", policy).from).toBe(
      "2000-01-01",
    );
  });

  test("a cursor ahead of today (a skewed clock) is read as today, never skipping a day", () => {
    expect(overlappingDateWindow("2026-09-01", "2026-07-19", policy)).toEqual({
      from: "2026-06-19",
      to: "2026-07-19",
      next: "2026-07-19",
    });
  });

  test("a cursor that is not a calendar day restarts from the origin", () => {
    expect(overlappingDateWindow("7", "2026-07-19", policy).from).toBe("2000-01-01");
    expect(overlappingDateWindow("2026-02-30", "2026-07-19", policy).from).toBe(
      "2000-01-01",
    );
  });

  test("refuses a today that is not a calendar day or a negative overlap", () => {
    expect(() => overlappingDateWindow(null, "19/07/2026", policy)).toThrow(RangeError);
    expect(() =>
      overlappingDateWindow(null, "2026-07-19", { ...policy, overlapDays: -1 }),
    ).toThrow(RangeError);
  });
});
