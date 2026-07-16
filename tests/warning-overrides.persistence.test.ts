import { createWorthlineStoreUnsafe } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

afterEach(cleanupTempDirs);

describe("warning overrides persistence", () => {
  test("acknowledging a warning persists, is idempotent, survives reopen, and can be removed", async () => {
    const path = tempDatabasePath("worthline-overrides-");
    const store = await createWorthlineStoreUnsafe({ databasePath: path });

    await store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_1");
    await store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_1"); // idempotent — no duplicate

    expect(await store.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "asset_1" },
    ]);
    store.close();

    const reopened = await createWorthlineStoreUnsafe({ databasePath: path });
    expect(await reopened.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "asset_1" },
    ]);

    await reopened.removeWarningOverride("ZERO_VALUE_ASSET", "asset_1");
    expect(await reopened.readWarningOverrides()).toEqual([]);
    reopened.close();
  });

  test("acknowledges overrideable signal kinds with the same persisted shape", async () => {
    const path = tempDatabasePath("worthline-overrides-signal-");
    const store = await createWorthlineStoreUnsafe({ databasePath: path });

    await store.acknowledgeWarning("STALE_MANUAL_VALUE", "asset_cash");

    expect(await store.readWarningOverrides()).toEqual([
      { code: "STALE_MANUAL_VALUE", entityId: "asset_cash" },
    ]);
    store.close();
  });
});
