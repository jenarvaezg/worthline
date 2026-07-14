import type { StoreContext } from "@db/store-context";
import { describe, expect, test } from "vitest";

import { createUnitOfWork } from "./unit-of-work";

function transactionalContext(state: { value: string }): StoreContext {
  return {
    transaction: async (work) => {
      const before = state.value;
      try {
        return await work();
      } catch (error) {
        state.value = before;
        throw error;
      }
    },
  } as StoreContext;
}

describe("private command UnitOfWork", () => {
  test("commits successful work", async () => {
    const state = { value: "Before" };
    const uow = createUnitOfWork(transactionalContext(state));

    await uow.transaction(() => {
      state.value = "After";
    });

    expect(state.value).toBe("After");
  });

  test("rolls back failed work", async () => {
    const state = { value: "Before" };
    const uow = createUnitOfWork(transactionalContext(state));

    await expect(
      uow.transaction(() => {
        state.value = "During";
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(state.value).toBe("Before");
  });
});
