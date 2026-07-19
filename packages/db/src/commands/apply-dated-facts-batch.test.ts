/**
 * ApplyDatedFactsBatch primitive (#966): one transaction, one ripple plan.
 */

import { describe, expect, test } from "vitest";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";

const TODAY = "2026-06-15";

const createdBatches: Array<{ id: string; trigger: string }> = [];
const immediateUow = {
  createFactBatch: async ({ trigger }: { trigger: string }) => {
    const id = `batch-${createdBatches.length + 1}`;
    createdBatches.push({ id, trigger });
    return id;
  },
  transaction: <T>(work: () => T | Promise<T>) => Promise.resolve(work()),
};

describe("applyDatedFactsBatch", () => {
  test("persists every step and ripples once from the earliest date", async () => {
    const persisted: string[] = [];
    const rippleCalls: string[] = [];

    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [
        {
          persist: async (batchId) => {
            expect(batchId).toMatch(/^batch-/);
            persisted.push("2024-06-01");
            return "2024-06-01";
          },
        },
        {
          persist: async (batchId) => {
            expect(batchId).toMatch(/^batch-/);
            persisted.push("2025-01-01");
            return "2025-01-01";
          },
        },
      ],
      ripple: async (fromDateKey) => {
        rippleCalls.push(fromDateKey);
      },
    });

    expect(result).toEqual({
      ok: true,
      value: { fromDateKey: "2024-06-01", today: TODAY },
    });
    expect(persisted).toEqual(["2024-06-01", "2025-01-01"]);
    expect(rippleCalls).toEqual(["2024-06-01"]);
  });

  test("skips ripple when the earliest date is in the future", async () => {
    const rippleCalls: string[] = [];
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [{ persist: async () => "2027-01-01" }],
      ripple: async (fromDateKey) => {
        rippleCalls.push(fromDateKey);
      },
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(rippleCalls).toEqual([]);
  });

  test("honours a custom deriveFromDateKey for edit windows", async () => {
    const rippleCalls: string[] = [];
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [
        { persist: async () => "2024-01-01" },
        { persist: async () => "2025-06-01" },
      ],
      deriveFromDateKey: (keys) => keys.sort()[0]!,
      ripple: async (fromDateKey) => {
        rippleCalls.push(fromDateKey);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ fromDateKey: "2024-01-01", today: TODAY });
    }
    expect(rippleCalls).toEqual(["2024-01-01"]);
  });

  test("returns null ripple plan for an empty batch", async () => {
    const before = createdBatches.length;
    const rippleCalls: string[] = [];
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [],
      ripple: async (fromDateKey) => {
        rippleCalls.push(fromDateKey);
      },
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(createdBatches).toHaveLength(before + 1);
    expect(rippleCalls).toEqual([]);
  });

  test("runs afterPersist inside the transaction, even for an empty batch", async () => {
    const order: string[] = [];
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [],
      afterPersist: async (batchId) => {
        expect(batchId).toMatch(/^batch-/);
        order.push("afterPersist");
      },
      ripple: async () => {
        order.push("ripple");
      },
    });

    expect(result).toEqual({ ok: true, value: null });
    // afterPersist ran; the empty batch skipped the ripple.
    expect(order).toEqual(["afterPersist"]);
  });

  test("runs afterPersist after steps and before the ripple", async () => {
    const order: string[] = [];
    await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [
        {
          persist: async () => {
            order.push("persist");
            return "2024-01-01";
          },
        },
      ],
      afterPersist: async () => {
        order.push("afterPersist");
      },
      ripple: async () => {
        order.push("ripple");
      },
    });

    expect(order).toEqual(["persist", "afterPersist", "ripple"]);
  });

  test("surfaces persist failures as CommandResult errors", async () => {
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [
        {
          persist: async () => {
            throw new Error("persist failed");
          },
        },
      ],
      ripple: async () => {},
    });

    expect(result).toEqual({ ok: false, error: "persist failed" });
  });

  test("surfaces ripple failures as CommandResult errors", async () => {
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [{ persist: async () => "2024-01-01" }],
      ripple: async () => {
        throw new Error("ripple failed");
      },
    });

    expect(result).toEqual({ ok: false, error: "ripple failed" });
  });
});
