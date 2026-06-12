/**
 * TDD tests for #60 ajustes — member reactivate and warning override retract.
 * Prior art: tests/workspace.persistence.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("member reactivate persistence", () => {
  test("reactivates a disabled member — clears disabledAt", () => {
    const store = createFileBackedStore("worthline-ajustes-");

    store.workspace.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    store.workspace.disableMember("member_ana", "2026-06-01T10:00:00.000Z");

    const afterDisable = store.workspace.readWorkspace();
    expect(afterDisable?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-01T10:00:00.000Z",
    );

    store.workspace.reactivateMember("member_ana");

    const afterReactivate = store.workspace.readWorkspace();
    expect(
      afterReactivate?.members.find((m) => m.id === "member_ana")?.disabledAt,
    ).toBeUndefined();
  });

  test("reactivating an already-active member is a no-op", () => {
    const store = createFileBackedStore("worthline-ajustes-");

    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    // Should not throw
    store.workspace.reactivateMember("member_jose");

    const workspace = store.workspace.readWorkspace();
    expect(
      workspace?.members.find((m) => m.id === "member_jose")?.disabledAt,
    ).toBeUndefined();
  });

  test("disable → reactivate → disable cycle persists correctly", () => {
    const store = createFileBackedStore("worthline-ajustes-");

    store.workspace.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    store.workspace.disableMember("member_ana", "2026-06-01T10:00:00.000Z");
    store.workspace.reactivateMember("member_ana");
    store.workspace.disableMember("member_ana", "2026-06-09T08:00:00.000Z");

    const workspace = store.workspace.readWorkspace();
    expect(workspace?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-09T08:00:00.000Z",
    );
  });
});

describe("warning override retract persistence", () => {
  test("retracting a specific override removes only that one", () => {
    const store = createFileBackedStore("worthline-ajustes-");

    store.workspace.initializeWorkspace({
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
    const store = createFileBackedStore("worthline-ajustes-");

    store.workspace.initializeWorkspace({
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
