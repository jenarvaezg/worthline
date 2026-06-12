import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";
import { tempDatabasePath, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("warning overrides persistence", () => {
  test("acknowledging a warning persists, is idempotent, survives reopen, and can be removed", () => {
    const path = tempDatabasePath("worthline-overrides-");
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
