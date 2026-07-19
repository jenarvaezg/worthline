import { describe, expect, test } from "vitest";

import {
  assertCapability,
  type ConnectorAdapter,
  type NormalizedBatch,
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
