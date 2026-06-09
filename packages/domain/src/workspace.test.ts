import { describe, expect, test } from "vitest";

import { createWorkspace, listScopeOptions, resolveScopeMemberIds } from "./index";

describe("workspace scopes", () => {
  test("resolves individual, household, and arbitrary group scopes", () => {
    const workspace = createWorkspace({
      mode: "household",
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
        { id: "member_luz", name: "Luz" },
      ],
      groups: [
        {
          id: "scope_adults",
          memberIds: ["member_ana", "member_jose"],
          name: "Adultos",
        },
      ],
    });

    expect(workspace.baseCurrency).toBe("EUR");
    expect(listScopeOptions(workspace)).toEqual([
      { id: "household", label: "Hogar", type: "household" },
      { id: "member_ana", label: "Ana", type: "member" },
      { id: "member_jose", label: "Jose", type: "member" },
      { id: "member_luz", label: "Luz", type: "member" },
      { id: "scope_adults", label: "Adultos", type: "group" },
    ]);
    expect(resolveScopeMemberIds(workspace, "household")).toEqual([
      "member_ana",
      "member_jose",
      "member_luz",
    ]);
    expect(resolveScopeMemberIds(workspace, "member_jose")).toEqual(["member_jose"]);
    expect(resolveScopeMemberIds(workspace, "scope_adults")).toEqual([
      "member_ana",
      "member_jose",
    ]);
  });

  test("disabled members are excluded from household scope", () => {
    const workspace = createWorkspace({
      mode: "household",
      members: [
        { id: "member_ana", name: "Ana" },
        { disabledAt: "2026-01-01", id: "member_jose", name: "Jose" },
        { id: "member_luz", name: "Luz" },
      ],
    });

    expect(listScopeOptions(workspace).map((s) => s.id)).toEqual([
      "household",
      "member_ana",
      "member_luz",
    ]);
    expect(resolveScopeMemberIds(workspace, "household")).toEqual([
      "member_ana",
      "member_luz",
    ]);
    expect(() => resolveScopeMemberIds(workspace, "member_jose")).toThrow(
      "Unknown scope",
    );
  });
});
