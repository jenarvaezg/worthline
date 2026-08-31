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
  formatDateKeyEs,
  type GlobalExposureProfile,
  type GlobalExposureProfileBreakdowns,
  type GlobalExposureProfileConfidence,
  type GlobalExposureProfileIdentity,
  globalExposureProfileIdentityKey,
  isGeoCurrencyNotApplicableAssetClass,
} from "@worthline/domain";

/** Tolerance for "the declared weights don't quite reach 100%". */
export const COVERAGE_EPSILON = 1e-9;

export type CatalogFilter =
  | "todos"
  | "por-categorizar"
  | "confianza-baja"
  | "corte-antiguo";

const CATALOG_FILTERS = [
  "todos",
  "por-categorizar",
  "confianza-baja",
  "corte-antiguo",
] as const satisfies readonly CatalogFilter[];

/**
 * A cut-off date older than this is stale enough to re-read the source (#1508).
 * A year is the cadence at which a fund's own factsheet has moved on: the
 * MyInvestor plan's only public monthly sheet was two years and four months
 * old, and nothing on the row said so.
 */
export const STALE_AS_OF_MONTHS = 12;

/**
 * Triage order for confidence: what to look at first. `baja` leads (a vector
 * that reads a mandate instead of a portfolio), then «sin declarar» — unknown
 * provenance, which is what every pre-#1508 row is — then `media`, then `alta`.
 */
const CONFIDENCE_RANK: Record<GlobalExposureProfileConfidence | "sin-declarar", number> =
  {
    baja: 0,
    "sin-declarar": 1,
    media: 2,
    alta: 3,
  };

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

/** Whether any applicable dimension leaves an undeclared remainder (#941, #1452). */
export function profileNeedsCategorizing(profile: GlobalExposureProfile): boolean {
  const geoCurrencyExempt = isGeoCurrencyNotApplicableAssetClass(
    profile.breakdowns.assetClass,
  );
  return CATALOG_DIMENSIONS.some((dimension) => {
    if (geoCurrencyExempt && (dimension === "geography" || dimension === "currency")) {
      return false;
    }
    return dimensionNeedsCategorizing(dimensionOf(profile.breakdowns, dimension));
  });
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

/** The word the list shows for a confidence level — `null` is «sin declarar». */
export function confidenceLabel(
  confidence: GlobalExposureProfileConfidence | null,
): string {
  return confidence ?? "sin declarar";
}

/**
 * A vector worth re-reading on provenance grounds: `baja` (it reads a mandate,
 * not a portfolio) or undeclared (nothing says where it came from).
 */
export function confidenceIsWeak(profile: GlobalExposureProfile): boolean {
  return profile.confidence === null || profile.confidence === "baja";
}

/** Rank used to sort least-trustworthy first. */
export function confidenceRank(profile: GlobalExposureProfile): number {
  return CONFIDENCE_RANK[profile.confidence ?? "sin-declarar"];
}

/**
 * Whole months from a cut-off day to `today`, both `YYYY-MM-DD`. Calendar
 * months, not 30-day blocks: a factsheet is dated by month, so «hace 14 meses»
 * is the honest reading of 2025-06-30 seen from 2026-08-31. Negative for a
 * cut-off in the future.
 */
export function asOfAgeMonths(asOfDate: string, today: string): number {
  const [fromYear, fromMonth, fromDay] = asOfDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = today.split("-").map(Number);
  if (
    [fromYear, fromMonth, fromDay, toYear, toMonth, toDay].some(
      (part) => !Number.isFinite(part),
    )
  ) {
    return 0;
  }
  const months = (toYear! - fromYear!) * 12 + (toMonth! - fromMonth!);
  return toDay! < fromDay! ? months - 1 : months;
}

/**
 * Whether the cut-off date is stale — older than {@link STALE_AS_OF_MONTHS}, or
 * absent. An undeclared cut-off counts as stale on purpose: a vector with no
 * date cannot be shown to be fresh, and «sin declarar» is exactly the state of
 * every row written before this seam.
 */
export function asOfIsStale(profile: GlobalExposureProfile, today: string): boolean {
  return (
    profile.asOfDate === null ||
    asOfAgeMonths(profile.asOfDate, today) >= STALE_AS_OF_MONTHS
  );
}

/** Cut-off day as the app reads it out loud, or «sin declarar» when absent. */
export function asOfText(profile: GlobalExposureProfile): string {
  return profile.asOfDate === null ? "sin declarar" : formatDateKeyEs(profile.asOfDate);
}

/** Count of weak-provenance profiles over the FULL set (#1508). */
export function countWeakConfidence(profiles: readonly GlobalExposureProfile[]): number {
  return profiles.reduce(
    (count, profile) => count + (confidenceIsWeak(profile) ? 1 : 0),
    0,
  );
}

/** Count of stale-cut-off profiles over the FULL set (#1508). */
export function countStaleAsOf(
  profiles: readonly GlobalExposureProfile[],
  today: string,
): number {
  return profiles.reduce(
    (count, profile) => count + (asOfIsStale(profile, today) ? 1 : 0),
    0,
  );
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
 * The profiles the list renders, filtered by search + triage filter and sorted
 * worst-first within each triage lens:
 *
 * - `por-categorizar` — only under-declared profiles, least-covered first.
 * - `confianza-baja` — only weak provenance (`baja` or undeclared), `baja` first.
 * - `corte-antiguo` — only stale cut-offs (older than {@link
 *   STALE_AS_OF_MONTHS}, or undeclared), oldest first with the undeclared ones
 *   ahead of them: no date at all is the least evidence of freshness there is.
 * - `todos` — the whole set, sorted by identity text.
 *
 * Ties always break by identity key, so the order is stable across renders.
 * `today` is a parameter, never the clock (ADR 0036 §7): the module stays pure
 * and the page decides what day it is.
 */
export function visibleProfiles(
  profiles: readonly GlobalExposureProfile[],
  state: Pick<CatalogViewState, "filter" | "query">,
  today: string,
): GlobalExposureProfile[] {
  const needle = state.query.trim().toLowerCase();
  const searched = profiles.filter((profile) => matchesQuery(profile, needle));
  const byKey = (a: GlobalExposureProfile, b: GlobalExposureProfile) =>
    profileKey(a).localeCompare(profileKey(b));

  if (state.filter === "por-categorizar") {
    return searched.filter(profileNeedsCategorizing).sort((a, b) => {
      const byCoverage = profileCoverage(a) - profileCoverage(b);
      return byCoverage !== 0 ? byCoverage : byKey(a, b);
    });
  }

  if (state.filter === "confianza-baja") {
    return searched.filter(confidenceIsWeak).sort((a, b) => {
      const byConfidence = confidenceRank(a) - confidenceRank(b);
      return byConfidence !== 0 ? byConfidence : byKey(a, b);
    });
  }

  if (state.filter === "corte-antiguo") {
    return searched
      .filter((profile) => asOfIsStale(profile, today))
      .sort((a, b) => {
        if (a.asOfDate === null || b.asOfDate === null) {
          if (a.asOfDate === b.asOfDate) {
            return byKey(a, b);
          }
          return a.asOfDate === null ? -1 : 1;
        }
        const byDate = a.asOfDate.localeCompare(b.asOfDate);
        return byDate !== 0 ? byDate : byKey(a, b);
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
  if (state.filter !== "todos") {
    params.set("filtro", state.filter);
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

/** An unknown `filtro` falls back to «todos» rather than showing nothing. */
function parseCatalogFilter(value: string | null | undefined): CatalogFilter {
  return CATALOG_FILTERS.find((filter) => filter === value) ?? "todos";
}

/** Parse view state from URL search params (deep-link + reload). */
export function parseCatalogParams(params: {
  filtro?: string | null;
  q?: string | null;
  perfil?: string | null;
}): CatalogViewState {
  return {
    filter: parseCatalogFilter(params.filtro),
    query: typeof params.q === "string" ? params.q : "",
    selectedKey: params.perfil ? params.perfil : null,
  };
}
