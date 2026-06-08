import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { withStore } from "@worthline/db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDatabasePath(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-migrate-"));
  tempDirs.push(dataDir);

  return join(dataDir, "worthline.sqlite");
}

describe("migrate idempotency", () => {
  test("opening an already-migrated database twice does not throw", () => {
    const databasePath = tempDatabasePath();

    withStore((store) => {
      store.initializeWorkspace({
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      });
    }, { databasePath });

    expect(() =>
      withStore((store) => store.readWorkspace()?.mode, { databasePath }),
    ).not.toThrow();
  });

  test("migrates a legacy database that has tables but no user_version", () => {
    const databasePath = tempDatabasePath();

    // Simulate a database created before user_version was introduced: a table
    // already exists and user_version is still 0.
    const legacy = new Database(databasePath);
    legacy.exec(
      "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    legacy.close();

    expect(() =>
      withStore((store) => store.readWorkspace(), { databasePath }),
    ).not.toThrow();
  });
});
