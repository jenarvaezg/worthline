import { listScopeOptions, resolveScopeMemberIds } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

describe("local workspace persistence", () => {
  test("initializes an individual EUR workspace with one member", async () => {
    const store = await createFileBackedStore("worthline-workspace-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    const workspace = await store.workspace.readWorkspace();

    expect(workspace?.baseCurrency).toBe("EUR");
    expect(workspace?.mode).toBe("individual");
    // Individual mode collapses to the single household scope — the lone person
    // is the household, so the selector never offers both (#269).
    expect(listScopeOptions(workspace!).map((scope) => scope.id)).toEqual(["household"]);
  });

  test("persists household members, groups, edits, and soft-disabled members", async () => {
    const store = await createFileBackedStore("worthline-workspace-");

    await store.workspace.initializeWorkspace({
      groups: [
        {
          id: "scope_adults",
          memberIds: ["member_ana", "member_jose"],
          name: "Adultos",
        },
      ],
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
        { id: "member_luz", name: "Luz" },
      ],
      mode: "household",
    });

    await store.workspace.createMember({ id: "member_noa", name: "Noa" });
    await store.workspace.updateMember({ id: "member_luz", name: "Lucia" });
    await store.workspace.disableMember("member_noa", "2026-06-08T20:00:00.000Z");

    const workspace = await store.workspace.readWorkspace();

    expect(workspace?.members).toMatchObject([
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
      { id: "member_luz", name: "Lucia" },
      {
        disabledAt: "2026-06-08T20:00:00.000Z",
        id: "member_noa",
        name: "Noa",
      },
    ]);
    expect(resolveScopeMemberIds(workspace!, "household")).toEqual([
      "member_ana",
      "member_jose",
      "member_luz",
    ]);
    expect(resolveScopeMemberIds(workspace!, "scope_adults")).toEqual([
      "member_ana",
      "member_jose",
    ]);
  });
});
