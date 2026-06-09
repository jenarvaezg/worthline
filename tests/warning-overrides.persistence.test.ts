import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "worthline-overrides-"));
  tempDirs.push(dir);

  return join(dir, "worthline.sqlite");
}

describe("warning overrides persistence", () => {
  test("acknowledging a warning persists, is idempotent, survives reopen, and can be removed", () => {
    const path = databasePath();
    const store = createWorthlineStore({ databasePath: path });

    store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_1");
    store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_1"); // idempotent — no duplicate

    expect(store.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "asset_1" },
    ]);
    store.close();

    const reopened = createWorthlineStore({ databasePath: path });
    expect(reopened.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "asset_1" },
    ]);

    reopened.removeWarningOverride("ZERO_VALUE_ASSET", "asset_1");
    expect(reopened.readWarningOverrides()).toEqual([]);
    reopened.close();
  });
});
