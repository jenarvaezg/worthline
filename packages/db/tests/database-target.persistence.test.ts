import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveDatabaseTarget, withStore } from "@db/index";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("database target resolution", () => {
  test("env URL plus auth token selects a remote libSQL workspace", () => {
    expect(
      resolveDatabaseTarget(
        {},
        {
          WORTHLINE_DB_AUTH_TOKEN: "group-token",
          WORTHLINE_DB_URL: "libsql://worthline-workspace.turso.io",
        },
      ),
    ).toEqual({
      authToken: "group-token",
      kind: "url",
      url: "libsql://worthline-workspace.turso.io",
    });
  });

  test("env database path keeps local test runs off the remote URL", () => {
    expect(
      resolveDatabaseTarget(
        {},
        {
          WORTHLINE_DB_AUTH_TOKEN: "group-token",
          WORTHLINE_DB_PATH: "/tmp/worthline-test.sqlite",
          WORTHLINE_DB_URL: "libsql://worthline-workspace.turso.io",
        },
      ),
    ).toEqual({
      databasePath: "/tmp/worthline-test.sqlite",
      kind: "path",
    });
  });

  test("remote libSQL URL requires an auth token", () => {
    expect(() =>
      resolveDatabaseTarget(
        {},
        { WORTHLINE_DB_URL: "libsql://worthline-workspace.turso.io" },
      ),
    ).toThrow(/WORTHLINE_DB_AUTH_TOKEN/);
  });

  test("withStore opens the env database URL", async () => {
    const databasePath = join(tempDir("worthline-url-target-"), "workspace.sqlite");
    const fallbackDataDir = tempDir("worthline-url-fallback-");
    const previous = {
      WORTHLINE_DATA_DIR: process.env.WORTHLINE_DATA_DIR,
      WORTHLINE_DB_AUTH_TOKEN: process.env.WORTHLINE_DB_AUTH_TOKEN,
      WORTHLINE_DB_URL: process.env.WORTHLINE_DB_URL,
    };

    process.env.WORTHLINE_DATA_DIR = fallbackDataDir;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
    process.env.WORTHLINE_DB_URL = `file:${databasePath}`;

    try {
      await withStore(async (store) => {
        await store.workspace.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });
      });

      await withStore(
        async (store) => {
          expect((await store.workspace.readWorkspace())?.mode).toBe("individual");
        },
        { databasePath },
      );
    } finally {
      if (previous.WORTHLINE_DATA_DIR === undefined) {
        delete process.env.WORTHLINE_DATA_DIR;
      } else {
        process.env.WORTHLINE_DATA_DIR = previous.WORTHLINE_DATA_DIR;
      }
      if (previous.WORTHLINE_DB_AUTH_TOKEN === undefined) {
        delete process.env.WORTHLINE_DB_AUTH_TOKEN;
      } else {
        process.env.WORTHLINE_DB_AUTH_TOKEN = previous.WORTHLINE_DB_AUTH_TOKEN;
      }
      if (previous.WORTHLINE_DB_URL === undefined) {
        delete process.env.WORTHLINE_DB_URL;
      } else {
        process.env.WORTHLINE_DB_URL = previous.WORTHLINE_DB_URL;
      }
    }
  });
});
