/**
 * TDD tests for #60 ajustes — member reactivate and warning override retract.
 * Prior art: tests/workspace.persistence.test.ts
 */
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

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-ajustes-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}

describe("member reactivate persistence", () => {
  test("reactivates a disabled member — clears disabledAt", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    store.disableMember("member_ana", "2026-06-01T10:00:00.000Z");

    const afterDisable = store.readWorkspace();
    expect(afterDisable?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-01T10:00:00.000Z",
    );

    store.reactivateMember("member_ana");

    const afterReactivate = store.readWorkspace();
    expect(
      afterReactivate?.members.find((m) => m.id === "member_ana")?.disabledAt,
    ).toBeUndefined();
  });

  test("reactivating an already-active member is a no-op", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    // Should not throw
    store.reactivateMember("member_jose");

    const workspace = store.readWorkspace();
    expect(workspace?.members.find((m) => m.id === "member_jose")?.disabledAt).toBeUndefined();
  });

  test("disable → reactivate → disable cycle persists correctly", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    store.disableMember("member_ana", "2026-06-01T10:00:00.000Z");
    store.reactivateMember("member_ana");
    store.disableMember("member_ana", "2026-06-09T08:00:00.000Z");

    const workspace = store.readWorkspace();
    expect(workspace?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-09T08:00:00.000Z",
    );
  });
});

describe("warning override retract persistence", () => {
  test("retracting a specific override removes only that one", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    store.acknowledgeWarning("zero_value", "asset_abc");
    store.acknowledgeWarning("zero_value", "asset_xyz");

    const afterAck = store.readWarningOverrides();
    expect(afterAck).toHaveLength(2);

    store.removeWarningOverride("zero_value", "asset_abc");

    const afterRetract = store.readWarningOverrides();
    expect(afterRetract).toHaveLength(1);
    expect(afterRetract[0]).toMatchObject({ code: "zero_value", entityId: "asset_xyz" });
  });

  test("retracting a non-existent override is a no-op", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    store.acknowledgeWarning("zero_value", "asset_abc");

    // Should not throw
    store.removeWarningOverride("zero_value", "asset_does_not_exist");

    const overrides = store.readWarningOverrides();
    expect(overrides).toHaveLength(1);
  });
});
