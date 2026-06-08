import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { withStore, type WorthlineStore } from "@worthline/db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDatabasePath(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-withstore-"));
  tempDirs.push(dataDir);

  return join(dataDir, "worthline.sqlite");
}

describe("withStore unit-of-work", () => {
  test("runs the callback against an open store and returns its result", () => {
    const databasePath = tempDatabasePath();

    const mode = withStore((store) => {
      store.initializeWorkspace({
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      });

      return store.readWorkspace()?.mode;
    }, { databasePath });

    expect(mode).toBe("individual");
  });

  test("closes the connection even when the callback throws", () => {
    const databasePath = tempDatabasePath();
    let captured: WorthlineStore | undefined;

    expect(() =>
      withStore((store) => {
        captured = store;
        throw new Error("boom");
      }, { databasePath }),
    ).toThrow("boom");

    // The connection must be closed despite the throw: using it now fails.
    expect(() => captured?.readWorkspace()).toThrow();
  });

  test("closes the connection on the happy path", () => {
    const databasePath = tempDatabasePath();
    let captured: WorthlineStore | undefined;

    withStore((store) => {
      captured = store;
    }, { databasePath });

    expect(() => captured?.readWorkspace()).toThrow();
  });
});
