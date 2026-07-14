/**
 * ApplyDatedFactsBatch primitive (#966): one transaction, one ripple plan.
 */

import { describe, expect, test } from "vitest";

import { applyDatedFactsBatch } from "./apply-dated-facts-batch";

const TODAY = "2026-06-15";

const immediateUow = {
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
          persist: async () => {
            persisted.push("2024-06-01");
            return "2024-06-01";
          },
        },
        {
          persist: async () => {
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
    const rippleCalls: string[] = [];
    const result = await applyDatedFactsBatch(immediateUow, {
      today: TODAY,
      steps: [],
      ripple: async (fromDateKey) => {
        rippleCalls.push(fromDateKey);
      },
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(rippleCalls).toEqual([]);
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
