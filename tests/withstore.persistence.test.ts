import { afterEach, describe, expect, test } from "vitest";

import { withStore, type WorthlineStore } from "@worthline/db";
import { tempDatabasePath, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("withStore unit-of-work", () => {
  test("runs the callback against an open store and returns its result", () => {
    const databasePath = tempDatabasePath("worthline-withstore-");

    const mode = withStore(
      (store) => {
        store.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });

        return store.readWorkspace()?.mode;
      },
      { databasePath },
    );

    expect(mode).toBe("individual");
  });

  test("closes the connection even when the callback throws", () => {
    const databasePath = tempDatabasePath("worthline-withstore-");
    let captured: WorthlineStore | undefined;

    expect(() =>
      withStore(
        (store) => {
          captured = store;
          throw new Error("boom");
        },
        { databasePath },
      ),
    ).toThrow("boom");

    // The connection must be closed despite the throw: using it now fails.
    expect(() => captured?.readWorkspace()).toThrow();
  });

  test("closes the connection on the happy path", () => {
    const databasePath = tempDatabasePath("worthline-withstore-");
    let captured: WorthlineStore | undefined;

    withStore(
      (store) => {
        captured = store;
      },
      { databasePath },
    );

    expect(() => captured?.readWorkspace()).toThrow();
  });
});
