/**
 * Home hero data-health alert selection (PRD #654 S3, #665) — pure module.
 *
 * The shared data-quality engine (`collectDataQualitySignals`) produces every
 * signal a scope carries; the home hero surfaces only the ones that change the
 * answer to "can I trust today's number?". This module is that selection: it
 * drops acknowledged (overridden) signals, keeps the highest-severity tier in
 * the engine's stable order, caps the list so the hero never becomes an
 * inventory, and resolves each signal's fix-surface link. Rendering-free and
 * side-effect-free so the wiring is unit-testable (impact / ordering / hrefs /
 * clean-is-empty) without a DOM.
 */

import { type HoldingPublicIdIndex, holdingDetailHref } from "@web/holding-route";
import {
  compareDataQualitySignals,
  type DataQualityCategory,
  type DataQualitySeverity,
  type DataQualitySignal,
  isOverrideableSignalCode,
  type WarningOverride,
} from "@worthline/domain";

/**
 * The hero's impact state. `error` = red, action-forward (a signal compromises
 * confidence in today's headline); `warning` = quieter gold (stale-but-usable);
 * `clean` = render nothing (no block, badge, separator, or residual space).
 */
export type HealthImpact = "error" | "warning" | "clean";

/** One actionable signal presented in the hero alert zone. */
export interface HeroHealthAlert {
  /** The signal's stable natural key — a React key and test anchor. */
  key: string;
  severity: DataQualitySeverity;
  /** Explicit, human text — the alert never relies on colour alone. */
  message: string;
  /** The holding/source/scope the signal concerns, when it has one. */
  affectedLabel: string | undefined;
  /** The fix surface to link to; `undefined` when there is nothing to open. */
  href: string | undefined;
  /** Short call-to-action label for the fix link. */
  fixLabel: string | undefined;
}

/** The resolved hero-alert view: impact state + the signals to render. */
export interface HeroHealthView {
  impact: HealthImpact;
  /** Empty when `impact` is `clean`. */
  alerts: readonly HeroHealthAlert[];
  /**
   * Top-tier signals beyond the cap that are not individually shown — surfaced
   * as a count so the hero stays honest without becoming an inventory.
   */
  hiddenCount: number;
}

/** Highest number of individual alerts the hero renders before summarising. */
export const HERO_HEALTH_MAX_ALERTS = 3;

const SEVERITY_RANK: Record<DataQualitySeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Resolve the home hero's data-health view from the scope's signals and the
 * user's acknowledged overrides. Overridden overrideable signals are dropped
 * (an acknowledged issue no longer nags); the rest are reduced to the single
 * highest-severity tier so the hero shows the worst thing first, not everything.
 */
export function selectHeroHealth(
  signals: readonly DataQualitySignal[],
  overrides: readonly WarningOverride[],
  publicIds: HoldingPublicIdIndex,
): HeroHealthView {
  const overridden = new Set(
    overrides.map((override) => `${override.code}:${override.entityId}`),
  );

  const actionable = signals.filter(
    (s) => bearsOnTodaysFigure(s) && !isAcknowledged(s, overridden),
  );
  if (actionable.length === 0) {
    return { alerts: [], hiddenCount: 0, impact: "clean" };
  }

  const topSeverity = actionable.reduce<DataQualitySeverity>(
    (worst, s) => (SEVERITY_RANK[s.severity] < SEVERITY_RANK[worst] ? s.severity : worst),
    "low",
  );

  const tier = actionable
    .filter((s) => s.severity === topSeverity)
    .sort(compareDataQualitySignals);

  const shown = tier.slice(0, HERO_HEALTH_MAX_ALERTS);

  return {
    alerts: shown.map((signal) => toAlert(signal, publicIds)),
    hiddenCount: tier.length - shown.length,
    impact: topSeverity === "high" ? "error" : "warning",
  };
}

/**
 * Signal categories/codes that do NOT bear on confidence in today's headline
 * figure, so they never headline the hero even though they stay in the shared
 * inventory (the agent view still surfaces them, PRD #654). A missing FIRE config
 * concerns projections and sparse/absent history concerns the evolution chart —
 * neither changes whether today's net worth can be trusted. The hero renders
 * "only while active signals affect confidence in today's figure" (#665).
 */
const NON_FIGURE_CATEGORIES: ReadonlySet<DataQualityCategory> = new Set([
  "history_coverage",
  // Declared-vs-measured savings (#1449) concerns the FIRE projection, exactly as
  // MISSING_FIRE_CONFIG below does — today's net worth is unaffected either way.
  // Its human surface is the FIRE panel on /objetivos, next to the figures it
  // actually moves; here it would push a real doubt about today's figure off the
  // hero. The agent view keeps it in the shared inventory.
  "savings_coherence",
]);
const NON_FIGURE_CODES: ReadonlySet<string> = new Set(["MISSING_FIRE_CONFIG"]);

function bearsOnTodaysFigure(signal: DataQualitySignal): boolean {
  return (
    !NON_FIGURE_CATEGORIES.has(signal.category) && !NON_FIGURE_CODES.has(signal.code)
  );
}

function isAcknowledged(
  signal: DataQualitySignal,
  overridden: ReadonlySet<string>,
): boolean {
  if (!isOverrideableSignalCode(signal.code) || signal.affected === undefined) {
    return false;
  }
  return overridden.has(`${signal.code}:${signal.affected.id}`);
}

function toAlert(
  signal: DataQualitySignal,
  publicIds: HoldingPublicIdIndex,
): HeroHealthAlert {
  const fix = fixSurface(signal, publicIds);
  return {
    affectedLabel: signal.affected?.label,
    fixLabel: fix?.label,
    href: fix?.href,
    key: signal.naturalKey,
    message: signal.label,
    severity: signal.severity,
  };
}

/**
 * The fix surface each signal links to — where seeing a problem and fixing it
 * are one step apart (PRD #654). Non-fixable, no-destination signals (a sparse
 * history the user cannot backfill) return null so the alert renders as text.
 */
function fixSurface(
  signal: DataQualitySignal,
  publicIds: HoldingPublicIdIndex,
): { href: string; label: string } | null {
  const affected = signal.affected;
  // A signal names its holding by the internal storage id; the link must name it
  // by the public `wl_hld_…` one (#1318). No public id → no link, never a link
  // to an id the router no longer accepts.
  const fichaHref = (): string | null => {
    const publicId = affected ? publicIds.publicByInternal.get(affected.id) : undefined;
    return publicId ? holdingDetailHref(publicId) : null;
  };
  switch (signal.category) {
    case "warning": {
      const href = fichaHref();
      return href ? { href, label: "Ver activo" } : null;
    }
    case "trashed_balance":
      // Not the holding's ficha — a trashed holding has none (every live read
      // excludes it). Both repairs live on the Papelera at the foot of the board:
      // restore it (then record the sale) or confirm the borrado (#1365). The
      // Papelera is a collapsed <details>, so the link has to unfold it too — a
      // bare `#papelera` would land on something the user cannot see.
      return { href: "/patrimonio?abrir=papelera#papelera", label: "Ver papelera" };
    case "manual_value_freshness":
      return { href: "/patrimonio/actualizar", label: "Actualizar valor" };
    case "price_freshness": {
      // The holding's edit surface — there is no standalone `/patrimonio/[id]`
      // detail route; editing is where its price provider/value is fixed.
      const href = fichaHref();
      return href ? { href, label: "Ver activo" } : null;
    }
    case "source_freshness":
    case "projection_gap":
      // Las fuentes vivas tienen página propia desde #1223; /ajustes solo lleva
      // ya una tarjeta-resumen, y el aviso apunta a donde se repara.
      return { href: "/ajustes/conexiones", label: "Ver fuentes" };
    case "missing_configuration": {
      // Only MISSING_DEBT_MODEL reaches the hero — MISSING_FIRE_CONFIG is
      // filtered out upstream (it does not bear on today's figure).
      const href = fichaHref();
      return href ? { href, label: "Ver deuda" } : null;
    }
    case "savings_coherence":
      // Filtered upstream today, but it has a real destination: the declared
      // capacity is typed in the FIRE form, which is where the gap gets settled.
      return { href: "/ajustes", label: "Revisar ahorro" };
    case "history_coverage":
      // Never surfaces (filtered upstream); handled for switch exhaustiveness.
      return null;
  }
}
