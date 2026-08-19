import type { FireScopeConfig } from "./fire";
import { findScopeMemberIds } from "./scope";
import type { Member, Workspace } from "./workspace-types";

/**
 * The reference age FIRE math runs on, derived from the member's birth date
 * instead of a typed scalar (#1415).
 *
 * A stored `currentAge` freezes: Jorge typed 62 in 2025 and the app still read
 * 62 in 2026, so every age the projection showed drifted one year younger
 * — always in the optimistic direction, and always growing. A birth date does
 * not expire, so it is the only thing worth storing; `FireScopeConfig.currentAge`
 * survives ONLY as the fallback for configs written before this change.
 *
 * Precision: with the month known the age is exact to the month. With only the
 * year we take `year − birthYear` and say so — ±1 year inside the natural year,
 * which is honest, unlike a permanent one-year lie.
 */

/** Nobody's age is negative, and nobody outlives this. Anything else is a typo. */
const MAX_PLAUSIBLE_AGE = 120;

/** The birth-date facts an age can be derived from (a `Member`'s subset). */
export type BirthDate = Pick<Member, "birthYear" | "birthMonth">;

/**
 * A calendar month as a 1-12 integer, or `undefined` for anything else. One door
 * for the range check, so the form parser and the age derivation cannot disagree
 * on what counts as a month: an out-of-range value is a typo, and reading it as a
 * month would shift the derived age by a year.
 */
export function parseCalendarMonth(value: unknown): number | undefined {
  const month = typeof value === "string" ? Number.parseInt(value.trim(), 10) : value;

  return typeof month === "number" && Number.isInteger(month) && month >= 1 && month <= 12
    ? month
    : undefined;
}

/**
 * Age on `onISO` (YYYY-MM-DD) from a birth year and, when known, a birth month.
 * The birthday counts as passed for the whole of its month — we do not know the
 * day, so pretending to know it would be false precision. Returns `undefined`
 * when the year is missing or yields an implausible age.
 */
export function ageOnDate(birth: BirthDate, onISO: string): number | undefined {
  const { birthYear, birthMonth } = birth;

  if (birthYear === undefined || !Number.isInteger(birthYear)) {
    return undefined;
  }

  const year = Number(onISO.slice(0, 4));
  // The read date's month goes through the same door as the birth month: a
  // malformed `2026-00-01` must not quietly subtract a year either.
  const month = parseCalendarMonth(Number(onISO.slice(5, 7)));
  const bornInMonth = parseCalendarMonth(birthMonth);

  if (!Number.isFinite(year)) {
    return undefined;
  }

  const age =
    year -
    birthYear -
    (month !== undefined && bornInMonth !== undefined && month < bornInMonth ? 1 : 0);

  return age >= 0 && age <= MAX_PLAUSIBLE_AGE ? age : undefined;
}

/**
 * A birth year that yields a plausible age on `todayISO`, or `undefined`.
 *
 * The stored year is accepted only when the derivation can read it back: a `2100`
 * or a mistyped `19630` would otherwise sit in the profile looking filled in while
 * `ageOnDate` refused it, and a workspace with no legacy age would lose the whole
 * coast block with the settings page insisting there is no birth date at all.
 * Storing exactly what the reader accepts is what keeps the two honest.
 */
export function parseBirthYear(value: unknown, todayISO: string): number | undefined {
  const year = typeof value === "string" ? Number.parseInt(value.trim(), 10) : value;

  if (typeof year !== "number" || !Number.isInteger(year)) {
    return undefined;
  }

  return ageOnDate({ birthYear: year }, todayISO) === undefined ? undefined : year;
}

/**
 * The scope's reference age together with the birth date it was derived from
 * (#1426). A derived figure the user cannot trace is a figure they do not
 * believe: «63 años (de tu año de nacimiento, 1963)» is the sentence that stops
 * the reader wondering why the projection's ages sit where they do.
 *
 * The member named here is the one whose age BINDS — see `scopeCurrentAge` for
 * why that is the oldest one.
 */
export interface FireAgeSource {
  /** The derived age on the read date. */
  age: number;
  memberId: string;
  memberName: string;
  birthYear: number;
  /** Only present when the member's birth month is recorded (age exact to the month). */
  birthMonth?: number;
}

/**
 * The scope's reference age and its provenance: the OLDEST active member who has
 * a birth year.
 *
 * In a multi-member scope the oldest member's horizon binds first — fewer years
 * of compounding before the target retirement age, so a higher coast
 * requirement. Taking the youngest would flatter the plan, which is the very
 * bug this replaces. `undefined` when no member of the scope has a birth year,
 * or when the scope no longer exists.
 */
export function scopeAgeSource(
  workspace: Workspace,
  scopeId: string,
  todayISO: string,
): FireAgeSource | undefined {
  const memberIds = findScopeMemberIds(workspace, scopeId);

  if (memberIds === undefined) {
    return undefined;
  }

  const inScope = new Set(memberIds);
  let oldest: FireAgeSource | undefined;

  for (const member of workspace.members) {
    if (!inScope.has(member.id)) {
      continue;
    }
    const age = ageOnDate(member, todayISO);
    // `ageOnDate` already refused an implausible or missing year, so a resolved age
    // guarantees the year is readable — hence the non-null assertion below.
    if (age === undefined || (oldest !== undefined && age <= oldest.age)) {
      continue;
    }
    const birthMonth = parseCalendarMonth(member.birthMonth);
    oldest = {
      age,
      birthYear: member.birthYear!,
      memberId: member.id,
      memberName: member.name,
      ...(birthMonth === undefined ? {} : { birthMonth }),
    };
  }

  return oldest;
}

/**
 * The scope's reference age — `scopeAgeSource(...)?.age`, so the age a screen
 * prints and the birth date it cites for it can never come from different members.
 */
export function scopeCurrentAge(
  workspace: Workspace,
  scopeId: string,
  todayISO: string,
): number | undefined {
  return scopeAgeSource(workspace, scopeId, todayISO)?.age;
}

/**
 * The one door every FIRE reader comes through (`store.readFireConfig`): the
 * stored configs with `currentAge` resolved from the members' birth dates.
 *
 * A scope with a derivable age gets it, stale or absent stored value replaced.
 * A scope without one keeps whatever the config already carried — dropping to
 * `undefined` would make `calculateFire` skip the coast block entirely and
 * `coastFireRequired` / `coastFireAge` would vanish with no explanation.
 */
export function withDerivedCurrentAges(
  configByScopeId: Record<string, FireScopeConfig>,
  workspace: Workspace | null,
  todayISO: string,
): Record<string, FireScopeConfig> {
  if (!workspace) {
    return configByScopeId;
  }

  const resolved: Record<string, FireScopeConfig> = {};

  for (const [scopeId, config] of Object.entries(configByScopeId)) {
    const derived = scopeCurrentAge(workspace, scopeId, todayISO);
    resolved[scopeId] =
      derived === undefined ? config : { ...config, currentAge: derived };
  }

  return resolved;
}
