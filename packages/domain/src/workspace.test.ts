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

  test("individual mode collapses to a single household scope (#269)", () => {
    const workspace = createWorkspace({
      mode: "individual",
      members: [{ id: "member_jose", name: "Jose" }],
    });

    // Household and the lone person are the same scope, so the selector must not
    // offer both — only the household option is listed, which the topbar then
    // hides (length <= 1). The scope still resolves to that single member.
    expect(listScopeOptions(workspace)).toEqual([
      { id: "household", label: "Hogar", type: "household" },
    ]);
    expect(resolveScopeMemberIds(workspace, "household")).toEqual(["member_jose"]);
  });

  test("household mode with a single member still lists both scopes (#269)", () => {
    const workspace = createWorkspace({
      mode: "household",
      members: [{ id: "member_jose", name: "Jose" }],
    });

    // The selector stays visible for households regardless of member count — only
    // individual mode collapses. Two scopes → topbar renders the bar.
    expect(listScopeOptions(workspace)).toEqual([
      { id: "household", label: "Hogar", type: "household" },
      { id: "member_jose", label: "Jose", type: "member" },
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
