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
 * The scope's reference age: the OLDEST active member who has a birth year.
 *
 * In a multi-member scope the oldest member's horizon binds first — fewer years
 * of compounding before the target retirement age, so a higher coast
 * requirement. Taking the youngest would flatter the plan, which is the very
 * bug this replaces. `undefined` when no member of the scope has a birth year,
 * or when the scope no longer exists.
 */
export function scopeCurrentAge(
  workspace: Workspace,
  scopeId: string,
  todayISO: string,
): number | undefined {
  const memberIds = findScopeMemberIds(workspace, scopeId);

  if (memberIds === undefined) {
    return undefined;
  }

  const inScope = new Set(memberIds);
  const ages = workspace.members
    .filter((member) => inScope.has(member.id))
    .map((member) => ageOnDate(member, todayISO))
    .filter((age): age is number => age !== undefined);

  return ages.length > 0 ? Math.max(...ages) : undefined;
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
