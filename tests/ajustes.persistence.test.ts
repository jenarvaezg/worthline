/**
 * TDD tests for #60 ajustes — member reactivate and warning override retract.
 * Prior art: tests/workspace.persistence.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

describe("member reactivate persistence", () => {
  test("reactivates a disabled member — clears disabledAt", async () => {
    const store = await createFileBackedStore("worthline-ajustes-");

    await store.workspace.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    await store.workspace.disableMember("member_ana", "2026-06-01T10:00:00.000Z");

    const afterDisable = await store.workspace.readWorkspace();
    expect(afterDisable?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-01T10:00:00.000Z",
    );

    await store.workspace.reactivateMember("member_ana");

    const afterReactivate = await store.workspace.readWorkspace();
    expect(
      afterReactivate?.members.find((m) => m.id === "member_ana")?.disabledAt,
    ).toBeUndefined();
  });

  test("reactivating an already-active member is a no-op", async () => {
    const store = await createFileBackedStore("worthline-ajustes-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    // Should not throw
    await store.workspace.reactivateMember("member_jose");

    const workspace = await store.workspace.readWorkspace();
    expect(
      workspace?.members.find((m) => m.id === "member_jose")?.disabledAt,
    ).toBeUndefined();
  });

  test("disable → reactivate → disable cycle persists correctly", async () => {
    const store = await createFileBackedStore("worthline-ajustes-");

    await store.workspace.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });

    await store.workspace.disableMember("member_ana", "2026-06-01T10:00:00.000Z");
    await store.workspace.reactivateMember("member_ana");
    await store.workspace.disableMember("member_ana", "2026-06-09T08:00:00.000Z");

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members.find((m) => m.id === "member_ana")?.disabledAt).toBe(
      "2026-06-09T08:00:00.000Z",
    );
  });
});

describe("warning override retract persistence", () => {
  test("retracting a specific override removes only that one", async () => {
    const store = await createFileBackedStore("worthline-ajustes-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    await store.acknowledgeWarning("zero_value", "asset_abc");
    await store.acknowledgeWarning("zero_value", "asset_xyz");

    const afterAck = await store.readWarningOverrides();
    expect(afterAck).toHaveLength(2);

    await store.removeWarningOverride("zero_value", "asset_abc");

    const afterRetract = await store.readWarningOverrides();
    expect(afterRetract).toHaveLength(1);
    expect(afterRetract[0]).toMatchObject({ code: "zero_value", entityId: "asset_xyz" });
  });

  test("retracting a non-existent override is a no-op", async () => {
    const store = await createFileBackedStore("worthline-ajustes-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    await store.acknowledgeWarning("zero_value", "asset_abc");

    // Should not throw
    await store.removeWarningOverride("zero_value", "asset_does_not_exist");

    const overrides = await store.readWarningOverrides();
    expect(overrides).toHaveLength(1);
  });
});
