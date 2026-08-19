import { describe, expect, it } from "vitest";
import type { FireScopeConfig } from "./fire";
import {
  ageOnDate,
  parseBirthYear,
  parseCalendarMonth,
  scopeAgeSource,
  scopeCurrentAge,
  withDerivedCurrentAges,
} from "./fire-current-age";
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

  it("ignores a malformed month in the read date too", () => {
    // Same defence on both sides: a `2026-00-01` must not quietly subtract a year
    // from someone whose birth month is known.
    expect(ageOnDate({ birthYear: 1963, birthMonth: 3 }, "2026-00-01")).toBe(63);
  });
});

describe("parseCalendarMonth", () => {
  it("accepts 1-12 from a number or the string a form posts", () => {
    expect(parseCalendarMonth(3)).toBe(3);
    expect(parseCalendarMonth(" 12 ")).toBe(12);
  });

  it("rejects anything that is not a calendar month", () => {
    // One door for the range, so the form parser and the derivation cannot
    // disagree: a bogus month would shift the derived age by a whole year.
    for (const value of [0, 13, -1, 1.5, "", "marzo", null, undefined]) {
      expect(parseCalendarMonth(value)).toBeUndefined();
    }
  });
});

describe("parseBirthYear", () => {
  it("accepts a year the derivation can read back", () => {
    expect(parseBirthYear("1963", "2026-08-18")).toBe(1963);
    expect(parseBirthYear(1963, "2026-08-18")).toBe(1963);
  });

  it("rejects a year that would leave the profile filled in but ageless", () => {
    // The last live route of the issue's review focus: a stored `2100` looks like
    // a birth date on screen while `ageOnDate` refuses it, so the coast block
    // disappears and the settings page claims there is no birth date at all.
    for (const value of ["2100", "19630", "", "mil novecientos", "1800", null]) {
      expect(parseBirthYear(value, "2026-08-18")).toBeUndefined();
    }
  });

  it("moves with the clock: this year is a valid birth year, next year is not", () => {
    expect(parseBirthYear("2026", "2026-08-18")).toBe(2026);
    expect(parseBirthYear("2027", "2026-08-18")).toBeUndefined();
  });
});

describe("scopeAgeSource", () => {
  it("names the birth date the age came from, so the screen can cite it (#1426)", () => {
    const workspace = workspaceOf(
      [{ id: "m1", name: "Jorge", birthYear: 1963, birthMonth: 3 }],
      "individual",
    );

    expect(scopeAgeSource(workspace, "household", "2026-08-18")).toEqual({
      age: 63,
      birthMonth: 3,
      birthYear: 1963,
      memberId: "m1",
      memberName: "Jorge",
    });
  });

  it("cites the member whose age actually binds — the oldest", () => {
    const workspace = workspaceOf(
      [
        { id: "m1", name: "Jorge", birthYear: 1963 },
        { id: "m2", name: "Ana", birthYear: 1975 },
      ],
      "household",
    );

    expect(scopeAgeSource(workspace, "household", "2026-08-18")?.memberName).toBe(
      "Jorge",
    );
  });

  it("leaves out a birth month nobody recorded", () => {
    const workspace = workspaceOf(
      [{ id: "m1", name: "Jorge", birthYear: 1963 }],
      "individual",
    );

    expect(scopeAgeSource(workspace, "household", "2026-08-18")).toEqual({
      age: 63,
      birthYear: 1963,
      memberId: "m1",
      memberName: "Jorge",
    });
  });

  it("is undefined when no member of the scope has a birth year", () => {
    const workspace = workspaceOf([{ id: "m1", name: "Jorge" }], "individual");

    expect(scopeAgeSource(workspace, "household", "2026-08-18")).toBeUndefined();
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
