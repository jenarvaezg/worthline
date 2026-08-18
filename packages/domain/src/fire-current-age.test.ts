import { describe, expect, it } from "vitest";
import type { FireScopeConfig } from "./fire";
import { ageOnDate, scopeCurrentAge, withDerivedCurrentAges } from "./fire-current-age";
import type { Member, Workspace } from "./workspace-types";
import { createWorkspace } from "./workspace-types";

function workspaceOf(members: Member[], mode: "individual" | "household"): Workspace {
  return createWorkspace({ members, mode });
}

const config: FireScopeConfig = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
};

describe("ageOnDate", () => {
  it("counts the birthday as already passed when the month is reached", () => {
    expect(ageOnDate({ birthYear: 1963, birthMonth: 8 }, "2026-08-18")).toBe(63);
  });

  it("subtracts a year when the birth month is still ahead", () => {
    expect(ageOnDate({ birthYear: 1963, birthMonth: 12 }, "2026-08-18")).toBe(62);
  });

  it("falls back to the calendar-year difference when the month is unknown", () => {
    // Documented convention (#1415): year − birthYear, ±1 year of honest
    // indeterminacy inside the natural year. Never a frozen typed scalar.
    expect(ageOnDate({ birthYear: 1963 }, "2026-01-02")).toBe(63);
  });

  it("returns undefined for a birth year that cannot be an age", () => {
    expect(ageOnDate({ birthYear: 2030 }, "2026-08-18")).toBeUndefined();
    expect(ageOnDate({ birthYear: 1800 }, "2026-08-18")).toBeUndefined();
  });

  it("ignores a birth month outside 1–12 instead of shifting the age", () => {
    expect(ageOnDate({ birthYear: 1963, birthMonth: 0 }, "2026-08-18")).toBe(63);
    expect(ageOnDate({ birthYear: 1963, birthMonth: 13 }, "2026-08-18")).toBe(63);
  });
});

describe("scopeCurrentAge", () => {
  it("derives the household age from the single member in individual mode", () => {
    const workspace = workspaceOf(
      [{ id: "m1", name: "Jorge", birthYear: 1963, birthMonth: 3 }],
      "individual",
    );
    expect(scopeCurrentAge(workspace, "household", "2026-08-18")).toBe(63);
  });

  it("takes the oldest member of a multi-member scope", () => {
    // The oldest member's horizon binds first: fewer years of compounding, a
    // higher coast requirement. Never the optimistic reading.
    const workspace = workspaceOf(
      [
        { id: "m1", name: "Jorge", birthYear: 1963 },
        { id: "m2", name: "Ana", birthYear: 1975 },
      ],
      "household",
    );
    expect(scopeCurrentAge(workspace, "household", "2026-08-18")).toBe(63);
    expect(scopeCurrentAge(workspace, "m2", "2026-08-18")).toBe(51);
  });

  it("ignores disabled members and members without a birth year", () => {
    const workspace = workspaceOf(
      [
        { id: "m1", name: "Jorge", birthYear: 1930, disabledAt: "2026-01-01" },
        { id: "m2", name: "Ana", birthYear: 1975 },
        { id: "m3", name: "Sin ficha" },
      ],
      "household",
    );
    expect(scopeCurrentAge(workspace, "household", "2026-08-18")).toBe(51);
  });

  it("is undefined when no member of the scope has a birth year", () => {
    const workspace = workspaceOf([{ id: "m1", name: "Jorge" }], "individual");
    expect(scopeCurrentAge(workspace, "household", "2026-08-18")).toBeUndefined();
  });

  it("is undefined for a scope that no longer exists", () => {
    const workspace = workspaceOf(
      [{ id: "m1", name: "Jorge", birthYear: 1963 }],
      "individual",
    );
    expect(scopeCurrentAge(workspace, "grp_deleted", "2026-08-18")).toBeUndefined();
  });
});

describe("withDerivedCurrentAges", () => {
  const workspace = workspaceOf(
    [{ id: "m1", name: "Jorge", birthYear: 1963, birthMonth: 3 }],
    "individual",
  );

  it("overrides a stale stored age with the derived one", () => {
    const derived = withDerivedCurrentAges(
      { household: { ...config, currentAge: 62 } },
      workspace,
      "2026-08-18",
    );
    expect(derived.household?.currentAge).toBe(63);
  });

  it("adds an age to a config that never had one", () => {
    const derived = withDerivedCurrentAges(
      { household: config },
      workspace,
      "2026-08-18",
    );
    expect(derived.household?.currentAge).toBe(63);
  });

  it("keeps the legacy stored age when nothing can be derived", () => {
    // The silent failure this guards (#1415): dropping to `undefined` makes
    // calculateFire skip coast entirely — no coastFireRequired, no warning.
    const ageless = workspaceOf([{ id: "m1", name: "Jorge" }], "individual");
    const derived = withDerivedCurrentAges(
      { household: { ...config, currentAge: 48 } },
      ageless,
      "2026-08-18",
    );
    expect(derived.household?.currentAge).toBe(48);
  });

  it("leaves untouched a scope whose members are gone", () => {
    const derived = withDerivedCurrentAges(
      { grp_gone: { ...config, currentAge: 40 } },
      workspace,
      "2026-08-18",
    );
    expect(derived.grp_gone?.currentAge).toBe(40);
  });

  it("returns new objects instead of mutating the input", () => {
    const input = { household: { ...config, currentAge: 62 } };
    const derived = withDerivedCurrentAges(input, workspace, "2026-08-18");
    expect(input.household.currentAge).toBe(62);
    expect(derived.household).not.toBe(input.household);
  });
});
