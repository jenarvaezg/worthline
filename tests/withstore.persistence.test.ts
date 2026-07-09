import { type WorthlineStore, withStore } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

afterEach(cleanupTempDirs);

describe("withStore unit-of-work", () => {
  test("runs the callback against an open store and returns its result", async () => {
    const databasePath = tempDatabasePath("worthline-withstore-");

    const mode = await withStore(
      async (store) => {
        await store.workspace.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });

        return (await store.workspace.readWorkspace())?.mode;
      },
      { databasePath },
    );

    expect(mode).toBe("individual");
  });

  test("closes the connection even when the callback throws", async () => {
    const databasePath = tempDatabasePath("worthline-withstore-");
    let captured: WorthlineStore | undefined;

    await expect(
      withStore(
        (store) => {
          captured = store;
          throw new Error("boom");
        },
        { databasePath },
      ),
    ).rejects.toThrow("boom");

    // The connection must be closed despite the throw: using it now fails.
    await expect(captured?.workspace.readWorkspace()).rejects.toThrow();
  });

  test("closes the connection on the happy path", async () => {
    const databasePath = tempDatabasePath("worthline-withstore-");
    let captured: WorthlineStore | undefined;

    await withStore(
      (store) => {
        captured = store;
      },
      { databasePath },
    );

    await expect(captured?.workspace.readWorkspace()).rejects.toThrow();
  });
});
