import { afterEach, describe, expect, test } from "vitest";

import { listScopeOptions, resolveScopeMemberIds } from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("local workspace persistence", () => {
  test("initializes an individual EUR workspace with one member", () => {
    const store = createFileBackedStore("worthline-workspace-");

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });

    const workspace = store.readWorkspace();

    expect(workspace?.baseCurrency).toBe("EUR");
    expect(workspace?.mode).toBe("individual");
    expect(listScopeOptions(workspace!).map((scope) => scope.id)).toEqual([
      "household",
      "member_jose",
    ]);
  });

  test("persists household members, groups, edits, and soft-disabled members", () => {
    const store = createFileBackedStore("worthline-workspace-");

    store.initializeWorkspace({
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

    store.createMember({ id: "member_noa", name: "Noa" });
    store.updateMember({ id: "member_luz", name: "Lucia" });
    store.disableMember("member_noa", "2026-06-08T20:00:00.000Z");

    const workspace = store.readWorkspace();

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
