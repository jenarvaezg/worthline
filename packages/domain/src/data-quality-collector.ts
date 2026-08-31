/**
 * The collector contract, and the vocabulary every data-quality family speaks
 * (PRD #654 S1, #328).
 *
 * What a signal IS — its shape, its categories, its identity and its order — plus
 * the contract the facade registers families against. It holds no rule of its
 * own: each family owns its rule and its input, and this module owns only what
 * they must agree on so their signals can sit in one list.
 */

import type { WarningOverride } from "./warnings";

export type DataQualityCategory =
  | "warning"
  | "trashed_balance"
  | "manual_value_freshness"
  | "price_freshness"
  | "source_freshness"
  | "missing_configuration"
  | "savings_coherence"
  | "spending_coherence"
  | "portfolio_reconciliation"
  | "transfer_integrity"
  | "history_coverage"
  | "projection_gap";

export type DataQualitySeverity = "high" | "medium" | "low";

export type DataQualityAffectedObject =
  | "holding"
  | "scope"
  | "connected_source"
  /** A cartera gestionada (ADR 0085) — a grouping entity, never a holding. */
  | "managed_portfolio";

/** Internal reference to the object a signal concerns. */
export interface DataQualityAffectedRef {
  object: DataQualityAffectedObject;
  id: string;
  label: string;
}

/**
 * One normalized data-quality signal with internal references. The stable
 * `naturalKey` (`category:code:affectedEntityId`) is the identity seam for
 * public-id derivation and stable ordering.
 */
export interface DataQualitySignal {
  naturalKey: string;
  category: DataQualityCategory;
  severity: DataQualitySeverity;
  label: string;
  code: string;
  fixable: boolean;
  affected?: DataQualityAffectedRef;
  observedDate?: string;
  originalWarningType?: string;
}

export interface DataQualityScopeContext {
  internalScopeId: string;
  scopeLabel: string;
}

/**
 * The acknowledgements the user has recorded (ADR 0004). Read by every family
 * whose signal can be marked intentional; surfacing one never writes an
 * override (ADR 0023).
 */
export interface DataQualityOverrideInput {
  warningOverrides: readonly WarningOverride[];
}

/**
 * What the facade resolves ONCE and hands to every collector, so no family
 * re-derives it — and so two signals about the same holding can never disagree
 * about whether the scope owns it.
 */
export interface DataQualityScopeFacts {
  /** Holdings (assets and liabilities) the scope owns. */
  readonly ownedAssetIds: ReadonlySet<string>;
  /** Members the scope resolves to — the ownership intersection the trash uses. */
  readonly scopeMemberIds: ReadonlySet<string>;
  /** `code:entityId` of every acknowledged signal, folded from the overrides. */
  readonly overriddenKeys: ReadonlySet<string>;
}

/**
 * One family of data-quality signal: a pure function from the inputs IT declares
 * (plus the scope facts every family shares) to the signals it owns.
 *
 * The `Input` parameter is the point of the registry: a family declares the slice
 * of the collection input it reads, and the facade's public input is the union of
 * those declarations. Adding a family adds a module, not a field to a god-bag.
 */
export type DataQualityCollector<Input> = (
  input: Input & DataQualityScopeFacts,
) => DataQualitySignal[];

/** Stable category order for the secondary sort key (PRD #328). */
export const DATA_QUALITY_CATEGORY_ORDER: readonly DataQualityCategory[] = [
  "warning",
  "trashed_balance",
  "manual_value_freshness",
  "price_freshness",
  "source_freshness",
  "missing_configuration",
  "savings_coherence",
  "spending_coherence",
  "portfolio_reconciliation",
  "transfer_integrity",
  "history_coverage",
  "projection_gap",
];

const SEVERITY_RANK: Record<DataQualitySeverity, number> = {
  high: 0,
  low: 2,
  medium: 1,
};

/** Sort key: severity DESC, category, affected id, natural key. */
export function dataQualitySignalSortKey(signal: DataQualitySignal): {
  dateKey: string;
  tieBreaker: string;
} {
  const categoryRank = DATA_QUALITY_CATEGORY_ORDER.indexOf(signal.category);
  const affectedId = signal.affected?.id ?? "";
  return {
    dateKey: `${SEVERITY_RANK[signal.severity]}|${categoryRank}|${affectedId}`,
    tieBreaker: signal.naturalKey,
  };
}

export function compareDataQualitySignals(
  left: DataQualitySignal,
  right: DataQualitySignal,
): number {
  const a = dataQualitySignalSortKey(left);
  const b = dataQualitySignalSortKey(right);
  const byPrimary = a.dateKey.localeCompare(b.dateKey);
  if (byPrimary !== 0) {
    return byPrimary;
  }
  return a.tieBreaker.localeCompare(b.tieBreaker);
}

export function signalNaturalKey(
  category: DataQualityCategory,
  code: string,
  affectedEntityId: string,
): string {
  return `${category}:${code}:${affectedEntityId}`;
}

/** Fold the persisted overrides into the `code:entityId` keys families look up. */
export function overriddenSignalKeys(
  warningOverrides: readonly WarningOverride[],
): ReadonlySet<string> {
  return new Set(
    warningOverrides.map((override) => `${override.code}:${override.entityId}`),
  );
}

/**
 * An acknowledged signal stays in the inventory and gets LABELLED, never dropped
 * (ADR 0004) — one wording for every family that can be acknowledged.
 */
export function signalLabelWithOverride(
  baseLabel: string,
  code: string,
  entityId: string,
  overriddenKeys: ReadonlySet<string>,
  overrideable: boolean,
): string {
  if (!overrideable || !overriddenKeys.has(`${code}:${entityId}`)) {
    return baseLabel;
  }

  return `${baseLabel} (marcado como intencional)`;
}

export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}
