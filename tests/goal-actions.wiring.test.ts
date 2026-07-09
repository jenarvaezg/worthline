import { createGoalAction } from "@web/objetivos/goal-actions";

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";
import { catchRedirect, fd } from "./helpers";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setupStore(): Promise<WorthlineStore> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_ana", name: "Ana" }],
    mode: "individual",
  });
  return store;
}

describe("createGoalAction wiring", () => {
  test("invalid scope id redirects with an error and does not create an orphan goal", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      createGoalAction(
        fd(
          {
            scopeId: "ghost_scope",
            name: "Entrada vivienda",
            targetAmount: "60000",
            deadline: "2030-12-31",
            priority: "high",
          },
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/scope/i);
    expect(await store.goals.readGoals()).toEqual([]);
  });
});
