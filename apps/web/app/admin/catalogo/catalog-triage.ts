/**
 * Pure, node-testable triage logic for the global exposure-profile catalog
 * (PRD #711 S4, decision #941). The admin list is a *triage register*, not a
 * quantifier: it flags profiles whose honest breakdown leaves an undeclared
 * remainder and lets the admin filter/sort to the least-covered first. All the
 * weighted-breakdown quantification and editing happens in the detail panel;
 * this module only computes what the list needs (interaction-patterns §7:
 * behaviour lives in a pure module, the component is a thin shell).
 *
 * Weights are non-figure metadata (ADR 0039): float arithmetic with an epsilon
 * is honest enough for a coverage indicator. The authoritative weight validation
 * (each ∈ [0,1], each dimension ≤ 1) is enforced server-side by the domain
 * contract (#940) before anything persists.
 */
import {
  type GlobalExposureProfile,
  type GlobalExposureProfileBreakdowns,
  type GlobalExposureProfileIdentity,
  globalExposureProfileIdentityKey,
} from "@worthline/domain";

/** Tolerance for "the declared weights don't quite reach 100%". */
export const COVERAGE_EPSILON = 1e-9;

export type CatalogFilter = "todos" | "por-categorizar";

/** The list's three triage dimensions, in display order. */
export const CATALOG_DIMENSIONS = ["geography", "currency", "assetClass"] as const;
export type CatalogDimension = (typeof CATALOG_DIMENSIONS)[number];

export interface CatalogViewState {
  filter: CatalogFilter;
  query: string;
  selectedKey: string | null;
}

function dimensionOf(
  breakdowns: GlobalExposureProfileBreakdowns,
  dimension: CatalogDimension,
): Record<string, string> | undefined {
  return breakdowns[dimension] as Record<string, string> | undefined;
}

/** Sum of a dimension's weights, unclamped — non-numeric entries count as 0. */
export function sumWeights(breakdown: Record<string, string> | undefined): number {
  if (!breakdown) {
    return 0;
  }
  return Object.values(breakdown).reduce((total, weight) => {
    const parsed = Number(weight);
    return total + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

/** Declared fraction of one dimension (Σ weights), clamped to [0, 1]. */
export function dimensionDeclared(breakdown: Record<string, string> | undefined): number {
  return Math.min(1, Math.max(0, sumWeights(breakdown)));
}

/** The undeclared remainder of one dimension (1 − declared). */
export function dimensionRemainder(
  breakdown: Record<string, string> | undefined,
): number {
  return Math.max(0, 1 - dimensionDeclared(breakdown));
}

/**
 * A dimension "needs categorizing" when its declared weights leave any
 * undeclared remainder — including a dimension that is entirely absent (a
 * profile that has never been classified on that axis is the most in need).
 */
export function dimensionNeedsCategorizing(
  breakdown: Record<string, string> | undefined,
): boolean {
  return dimensionRemainder(breakdown) > COVERAGE_EPSILON;
}

/** Whether any of the three dimensions leaves an undeclared remainder (#941). */
export function profileNeedsCategorizing(profile: GlobalExposureProfile): boolean {
  return CATALOG_DIMENSIONS.some((dimension) =>
    dimensionNeedsCategorizing(dimensionOf(profile.breakdowns, dimension)),
  );
}

/**
 * Coverage score in [0, 1] — the average declared fraction across the three
 * dimensions. Drives the "least-covered first" ordering in triage mode.
 */
export function profileCoverage(profile: GlobalExposureProfile): number {
  const total = CATALOG_DIMENSIONS.reduce(
    (sum, dimension) =>
      sum + dimensionDeclared(dimensionOf(profile.breakdowns, dimension)),
    0,
  );
  return total / CATALOG_DIMENSIONS.length;
}

/** Count of profiles needing categorization over the FULL set (the gold badge). */
export function countNeedsCategorizing(
  profiles: readonly GlobalExposureProfile[],
): number {
  return profiles.reduce(
    (count, profile) => count + (profileNeedsCategorizing(profile) ? 1 : 0),
    0,
  );
}

/** Human-readable identity: the ISIN, or `provider · symbol`. */
export function identityText(identity: GlobalExposureProfileIdentity): string {
  return identity.kind === "isin"
    ? identity.isin
    : `${identity.priceProvider} · ${identity.providerSymbol}`;
}

/** Stable key for selection/URL — the domain's canonical identity key. */
export function profileKey(profile: GlobalExposureProfile): string {
  return globalExposureProfileIdentityKey(profile.identity);
}

function matchesQuery(profile: GlobalExposureProfile, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack =
    `${identityText(profile.identity)} ${profile.displayName ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * The profiles the list renders, filtered by search + triage filter and sorted.
 * In "por-categorizar" only under-declared profiles survive, least-covered
 * first (coverage ascending); ties break by identity for a stable order. In
 * "todos" the whole set is shown, sorted by identity text.
 */
export function visibleProfiles(
  profiles: readonly GlobalExposureProfile[],
  state: Pick<CatalogViewState, "filter" | "query">,
): GlobalExposureProfile[] {
  const needle = state.query.trim().toLowerCase();
  const searched = profiles.filter((profile) => matchesQuery(profile, needle));

  if (state.filter === "por-categorizar") {
    return searched.filter(profileNeedsCategorizing).sort((a, b) => {
      const byCoverage = profileCoverage(a) - profileCoverage(b);
      return byCoverage !== 0 ? byCoverage : profileKey(a).localeCompare(profileKey(b));
    });
  }

  return [...searched].sort((a, b) =>
    identityText(a.identity).localeCompare(identityText(b.identity)),
  );
}

/**
 * Serialize view state into a query string for `history.pushState` (§3: the URL
 * stays the source of truth). Only non-default values are written, so a pristine
 * view is a clean `/admin/catalogo`.
 */
export function catalogSearchString(state: CatalogViewState): string {
  const params = new URLSearchParams();
  if (state.filter === "por-categorizar") {
    params.set("filtro", "por-categorizar");
  }
  if (state.query.trim()) {
    params.set("q", state.query.trim());
  }
  if (state.selectedKey) {
    params.set("perfil", state.selectedKey);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Parse view state from URL search params (deep-link + reload). */
export function parseCatalogParams(params: {
  filtro?: string | null;
  q?: string | null;
  perfil?: string | null;
}): CatalogViewState {
  return {
    filter: params.filtro === "por-categorizar" ? "por-categorizar" : "todos",
    query: typeof params.q === "string" ? params.q : "",
    selectedKey: params.perfil ? params.perfil : null,
  };
}
