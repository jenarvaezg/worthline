import type { FireScopeConfig } from "./fire";

/**
 * The monthly savings the FIRE projection contributes — the scalar the user
 * declared, and nothing else (#1416, ADR 0074).
 *
 * It used to be derived from the contribution plan when the plan had rows, with
 * the declared scalar kept only as a fallback (ADR 0041). That derivation is
 * retired: the plan models *planned contributions to named destinations*, a
 * subset of what somebody saves, so substituting it for a declared total
 * under-estimates by construction. Jorge declared 1.500 €/mes and the app
 * projected the 100 €/mes of his single pension-plan row — five years of FIRE
 * date, with nothing on screen saying the app had stopped listening. And because
 * the guard asked whether the plan was *empty* rather than whether it was
 * *active*, the day his last row expired the capacity would have dropped to 0
 * without him touching a field.
 *
 * In FIRE live final values — a deliberate simplification. What is measured or
 * derived elsewhere is a lens or a warning (#1449 watches declared against
 * measured), never an input that overwrites the declaration.
 *
 * Absent reads as 0: the projection then contributes nothing, which is what a
 * user who never declared a capacity has told us. A negative declaration is
 * nonsense as a *capacity* (that is dis-saving, and #1449's business), so it
 * floors at 0 rather than projecting a shrinking pot from a stored typo.
 */
export function monthlySavingsCapacityForFire(config: FireScopeConfig): number {
  return Math.max(0, config.monthlySavingsCapacityMinor ?? 0);
}
