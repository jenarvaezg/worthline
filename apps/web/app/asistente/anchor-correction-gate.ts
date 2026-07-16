/**
 * Superficie C «Ancla primero» — pure interaction module (#1051, #1037).
 *
 * The confirmation gate, extremo recompute and point exclusions/edits of the
 * correction proposal card, kept as a pure, synchronous, testable module so the
 * card stays a thin shell (interaction-patterns §7). The gate the #1037
 * prototype codified:
 *
 *   resultado  = último punto incluido de la serie
 *   cuadra     = resultado === anclaConocida
 *   canConfirm = modo === "solo-desde-hoy" || cuadra
 *
 * S1 (anchor-only, this slice) and S2 (document reconstruction) share this
 * surface via the mode; S1 declares one point from today and always confirms,
 * S2 reconstructs a series that must reconcile to the anchor before Confirmar
 * unlocks.
 */

export type CorrectionSurfaceMode = "solo-desde-hoy" | "reconstruir" | "sin-ancla";

/** Origin of a series point — extracted by the assistant vs corrected by you. */
export type CorrectionPointOrigin = "assistant" | "user";

export interface CorrectionPoint {
  date: string;
  /** Minor units on the loan's own terms; null marks an unreadable point. */
  balanceMinor: number | null;
  origin: CorrectionPointOrigin;
  excluded?: boolean;
}

export type CorrectionGuarantee =
  /** solo-desde-hoy: declared by you, the past stays intact. */
  | { state: "declared" }
  /** reconstruir + the endpoint reconciles to the known anchor. */
  | { state: "reconciled"; anchorMinor: number; resultingMinor: number }
  /** reconstruir + the endpoint does not match the anchor yet. */
  | { state: "mismatch"; anchorMinor: number; resultingMinor: number | null }
  /** no anchor exists — the strong guarantee is absent, review is forced. */
  | { state: "unverified" };

export interface CorrectionGate {
  resultingMinor: number | null;
  matches: boolean;
  canConfirm: boolean;
  guarantee: CorrectionGuarantee;
}

function lastIncludedBalance(series: readonly CorrectionPoint[]): number | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const point = series[index]!;
    if (point.excluded) continue;
    return point.balanceMinor;
  }
  return null;
}

/**
 * The gate over a correction series. `anchorMinor` is the reconciliation anchor
 * (a present-day balance the reconstruction must reproduce); `null` means no
 * anchor exists ("No verificado"). In `solo-desde-hoy` the declaration IS the
 * truth, so Confirmar is always enabled.
 */
export function computeCorrectionGate(input: {
  mode: CorrectionSurfaceMode;
  series: readonly CorrectionPoint[];
  anchorMinor: number | null;
}): CorrectionGate {
  const { anchorMinor, mode, series } = input;
  const resultingMinor = lastIncludedBalance(series);

  if (mode === "solo-desde-hoy") {
    return {
      canConfirm: true,
      guarantee: { state: "declared" },
      matches: true,
      resultingMinor,
    };
  }

  if (mode === "sin-ancla" || anchorMinor === null) {
    return {
      canConfirm: false,
      guarantee: { state: "unverified" },
      matches: false,
      resultingMinor,
    };
  }

  const matches = resultingMinor === anchorMinor;
  return {
    canConfirm: matches,
    guarantee: matches
      ? { anchorMinor, resultingMinor: resultingMinor as number, state: "reconciled" }
      : { anchorMinor, resultingMinor, state: "mismatch" },
    matches,
    resultingMinor,
  };
}

/**
 * Immutably edit one series point — override its amount (marking it corrected by
 * you) or toggle its exclusion. Out-of-range indices return the series unchanged.
 */
export function editCorrectionPoint(
  series: readonly CorrectionPoint[],
  index: number,
  change: { balanceMinor?: number | null; excluded?: boolean },
): CorrectionPoint[] {
  if (index < 0 || index >= series.length) return [...series];
  return series.map((point, position) => {
    if (position !== index) return point;
    const next: CorrectionPoint = { ...point };
    if ("balanceMinor" in change && change.balanceMinor !== undefined) {
      next.balanceMinor = change.balanceMinor;
      next.origin = "user";
    }
    if (change.excluded !== undefined) next.excluded = change.excluded;
    return next;
  });
}
