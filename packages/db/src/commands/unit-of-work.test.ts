/**
 * UnitOfWork (#966): wraps the store transaction seam for command executors.
 */

import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

describe("UnitOfWork via store.command.uow", () => {
  test("commits work inside the store transaction", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Member" }],
      mode: "individual",
    });

    await store.command.uow.transaction(async () => {
      await store.workspace.updateMember({ id: "m1", name: "Renamed" });
    });

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members[0]?.name).toBe("Renamed");

    store.close();
  });

  test("rolls back when work inside the transaction throws", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Before" }],
      mode: "individual",
    });

    await expect(
      store.command.uow.transaction(async () => {
        await store.workspace.updateMember({ id: "m1", name: "During" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members[0]?.name).toBe("Before");

    store.close();
  });
});
