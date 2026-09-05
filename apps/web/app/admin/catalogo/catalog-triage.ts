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
  isRealCalendarDay,
} from "@worthline/domain";

/**
 * FLOAT tolerance, and nothing else: it exists so a vector that adds up to
 * 0.9999999 through rounding does not read as incomplete. It is NOT a relevance
 * threshold — see {@link MATERIAL_GAP_THRESHOLD} for that (#1678).
 */
export const COVERAGE_EPSILON = 1e-9;

/**
 * MATERIALITY threshold: below this, an undeclared remainder does not put a
 * ficha in the work queue (#1678). One percent, because the sub-1% gaps left in
 * the real catalog are all of the same kind — a fund's cash line whose currency
 * the audited report does not state, two tankers in flag-of-convenience
 * envelopes — and no source will ever fill them, so they would sit in the
 * register for ever beside gaps of thirty points.
 *
 * This threshold governs ATTENTION, never the data: the vector still declares
 * its remainder, the exposure lens still reads it as unknown coverage, and the
 * domain contract still refuses anything over 100% (ADR 0084, #1499).
 */
export const MATERIAL_GAP_THRESHOLD = 0.01;

export type CatalogFilter =
  | "todos"
  | "por-categorizar"
  | "confianza-baja"
  | "corte-antiguo";

/** The orders the register can be read in — independent of which rows it shows. */
export type CatalogSort = "identidad" | "cobertura" | "confianza" | "corte";

/**
 * A cut-off date older than this is stale enough to re-read the source (#1508).
 * A year is the cadence at which a fund's own factsheet has moved on: the
 * MyInvestor plan's only public monthly sheet was two years and four months
 * old, and nothing on the row said so.
 */
export const STALE_AS_OF_MONTHS = 12;

/** Rank of a declared confidence — lower is more urgent to look at. */
const DECLARED_CONFIDENCE_RANK: Record<GlobalExposureProfileConfidence, number> = {
  baja: 0,
  media: 2,
  alta: 3,
};

/**
 * Where an undeclared confidence sits: after `baja` (a known bad reading) and
 * before `media` — nothing says where the vector came from, and that is what
 * every pre-#1508 row is.
 */
const UNDECLARED_CONFIDENCE_RANK = 1;

/** What the list says about a provenance nobody declared. */
export const UNDECLARED_TEXT = "sin declarar";

/** The list's three triage dimensions, in display order. */
export const CATALOG_DIMENSIONS = ["geography", "currency", "assetClass"] as const;
export type CatalogDimension = (typeof CATALOG_DIMENSIONS)[number];

export interface CatalogViewState {
  filter: CatalogFilter;
  query: string;
  /** Explicit order, or `null` to read the active lens's own worst-first order. */
  sort: CatalogSort | null;
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
 * A dimension "needs categorizing" when its undeclared remainder is MATERIAL —
 * over {@link MATERIAL_GAP_THRESHOLD}, not merely over the float epsilon. A
 * dimension that is entirely absent is the most in need, so it always qualifies.
 *
 * The threshold is what makes the register a work queue: a gap the source will
 * never fill (a fund's «cash and margin cash» line whose currency the audited
 * report does not state) must not compete for attention with a thirty-point hole.
 */
export function dimensionNeedsCategorizing(
  breakdown: Record<string, string> | undefined,
): boolean {
  // The two constants collaborate rather than compete: the epsilon absorbs float
  // noise (1 − 0.99 is 0.010000000000000009, which would otherwise put a gap of
  // exactly the threshold on the wrong side), the threshold decides materiality.
  return dimensionRemainder(breakdown) > MATERIAL_GAP_THRESHOLD + COVERAGE_EPSILON;
}

/** The dimensions applicable to a profile — geo/currency drop out for metal and crypto. */
function applicableDimensions(
  profile: GlobalExposureProfile,
): readonly CatalogDimension[] {
  const geoCurrencyExempt = isGeoCurrencyNotApplicableAssetClass(
    profile.breakdowns.assetClass,
  );
  return geoCurrencyExempt
    ? CATALOG_DIMENSIONS.filter((dimension) => dimension === "assetClass")
    : CATALOG_DIMENSIONS;
}

/** Whether any applicable dimension leaves a MATERIAL remainder (#941, #1452, #1678). */
export function profileNeedsCategorizing(profile: GlobalExposureProfile): boolean {
  return applicableDimensions(profile).some((dimension) =>
    dimensionNeedsCategorizing(dimensionOf(profile.breakdowns, dimension)),
  );
}

/**
 * The largest undeclared remainder across the applicable dimensions, and which
 * dimension carries it — `null` when every one of them is complete. Reported
 * whatever its size: the list shows a sub-threshold gap in muted text rather
 * than hiding it, because the gap is true even when it is not worth chasing.
 */
export function profileWorstGap(
  profile: GlobalExposureProfile,
): { dimension: CatalogDimension; remainder: number } | null {
  let worst: { dimension: CatalogDimension; remainder: number } | null = null;
  for (const dimension of applicableDimensions(profile)) {
    const remainder = dimensionRemainder(dimensionOf(profile.breakdowns, dimension));
    if (remainder > COVERAGE_EPSILON && (worst === null || remainder > worst.remainder)) {
      worst = { dimension, remainder };
    }
  }
  return worst;
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

/** The word the list shows for a row's confidence — `null` is «sin declarar». */
export function confidenceText(profile: GlobalExposureProfile): string {
  return profile.confidence ?? UNDECLARED_TEXT;
}

/**
 * A vector worth re-reading on provenance grounds: `baja` (it reads a mandate,
 * not a portfolio) or undeclared (nothing says where it came from). The two are
 * one lens because they answer the same operational question — «¿me puedo fiar
 * de esta cifra?» — but they are never shown as the same state.
 */
export function confidenceIsWeak(profile: GlobalExposureProfile): boolean {
  return profile.confidence === null || profile.confidence === "baja";
}

/** Rank used to sort least-trustworthy first. */
export function confidenceRank(profile: GlobalExposureProfile): number {
  return profile.confidence === null
    ? UNDECLARED_CONFIDENCE_RANK
    : DECLARED_CONFIDENCE_RANK[profile.confidence];
}

/**
 * Whole months from a cut-off day to `today`, both real `YYYY-MM-DD` days.
 * Calendar months, not 30-day blocks: a factsheet is dated by month, so «hace 14
 * meses» is the honest reading of 2025-06-30 seen from 2026-08-31. Negative for
 * a cut-off in the future. Callers must hand it real days ({@link
 * isRealCalendarDay}); `asOfIsStale` is the guard that does.
 */
export function asOfAgeMonths(asOfDate: string, today: string): number {
  const [fromYear, fromMonth, fromDay] = asOfDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = today.split("-").map(Number);
  const months = (toYear! - fromYear!) * 12 + (toMonth! - fromMonth!);
  return toDay! < fromDay! ? months - 1 : months;
}

/**
 * Whether the cut-off date fails to show the vector is fresh: older than {@link
 * STALE_AS_OF_MONTHS}, absent, or not a real calendar day. The last two count as
 * stale on purpose — a vector with no readable date cannot be shown to be fresh,
 * and «sin declarar» is exactly the state of every row written before this seam.
 * The column is plain TEXT written by an out-of-repo pass, so garbage has to land
 * in the lens that asks a human to look, never in the silent "fresh" bucket.
 */
export function asOfIsStale(profile: GlobalExposureProfile, today: string): boolean {
  const asOfDate = asOfSortKey(profile);
  return asOfDate === null || asOfAgeMonths(asOfDate, today) >= STALE_AS_OF_MONTHS;
}

/**
 * The cut-off day to order by, or `null` when there is nothing orderable —
 * absent, or a value that is not a real calendar day.
 */
export function asOfSortKey(profile: GlobalExposureProfile): string | null {
  return profile.asOfDate !== null && isRealCalendarDay(profile.asOfDate)
    ? profile.asOfDate
    : null;
}

/**
 * Cut-off day as the app reads it out loud, «sin declarar» when absent, and the
 * stored text verbatim when it is not a date (never a prettified lie).
 */
export function asOfText(profile: GlobalExposureProfile): string {
  return profile.asOfDate === null ? UNDECLARED_TEXT : formatDateKeyEs(profile.asOfDate);
}

/**
 * How many profiles the given lens would show, over the FULL set — the badges
 * beside the filter. Counted here rather than off `visibleProfiles` so the
 * search box never changes what the counters say.
 */
export function countMatching(
  profiles: readonly GlobalExposureProfile[],
  filter: CatalogFilter,
  today: string,
): number {
  const matches = CATALOG_LENSES[filter].matches;
  return profiles.reduce(
    (count, profile) => count + (matches(profile, today) ? 1 : 0),
    0,
  );
}

/** Human-readable identity: the ISIN, DGS code, or `provider · symbol`. */
export function identityText(identity: GlobalExposureProfileIdentity): string {
  switch (identity.kind) {
    case "isin":
      return identity.isin;
    case "dgs":
      return identity.code;
    case "provider":
      return `${identity.priceProvider} · ${identity.providerSymbol}`;
  }
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

/** Ties always break by identity key, so any order is stable across renders. */
function byKey(a: GlobalExposureProfile, b: GlobalExposureProfile): number {
  return profileKey(a).localeCompare(profileKey(b));
}

/** Undeclared/unreadable cut-offs sort ahead of any real day: least evidence first. */
function byAsOf(a: GlobalExposureProfile, b: GlobalExposureProfile): number {
  const left = asOfSortKey(a);
  const right = asOfSortKey(b);
  if (left === null || right === null) {
    return left === right ? 0 : left === null ? -1 : 1;
  }
  return left.localeCompare(right);
}

/**
 * The four orders the register can be read in, each worst-first. They are
 * independent of the lens: any of them can be applied to «todos», which is what
 * makes «ver y ordenar por confianza y por antigüedad» possible without dropping
 * a single row.
 */
const CATALOG_COMPARATORS: Record<
  CatalogSort,
  (a: GlobalExposureProfile, b: GlobalExposureProfile) => number
> = {
  identidad: (a, b) => identityText(a.identity).localeCompare(identityText(b.identity)),
  cobertura: (a, b) => profileCoverage(a) - profileCoverage(b),
  confianza: (a, b) => confidenceRank(a) - confidenceRank(b),
  corte: byAsOf,
};

/**
 * The triage lenses: which rows each one keeps, the order it reads in when the
 * admin has not asked for another, and the word on its filter chip and counter.
 * One table so the vocabulary is spelled once — the union type, the URL value,
 * the label and the ordering cannot drift apart.
 */
export const CATALOG_LENSES: Record<
  CatalogFilter,
  {
    label: string;
    /** Counter wording — says «o sin declarar» wherever the lens folds those in. */
    countLabel: (count: number) => string;
    matches: (profile: GlobalExposureProfile, today: string) => boolean;
    defaultSort: CatalogSort;
  }
> = {
  todos: {
    label: "Todos",
    countLabel: (count) => `${count} fichas`,
    matches: () => true,
    defaultSort: "identidad",
  },
  "por-categorizar": {
    label: "Por categorizar",
    countLabel: (count) => `${count} por categorizar`,
    matches: (profile) => profileNeedsCategorizing(profile),
    defaultSort: "cobertura",
  },
  "confianza-baja": {
    label: "Baja o sin declarar",
    countLabel: (count) => `${count} de confianza baja o sin declarar`,
    matches: (profile) => confidenceIsWeak(profile),
    defaultSort: "confianza",
  },
  "corte-antiguo": {
    label: "Corte antiguo o sin fecha",
    countLabel: (count) =>
      `${count} con corte de más de ${STALE_AS_OF_MONTHS} meses o sin fecha`,
    matches: (profile, today) => asOfIsStale(profile, today),
    defaultSort: "corte",
  },
};

const CATALOG_FILTERS = Object.keys(CATALOG_LENSES) as readonly CatalogFilter[];
const CATALOG_SORTS = Object.keys(CATALOG_COMPARATORS) as readonly CatalogSort[];

/** The lenses in the order the filter renders them. */
export const CATALOG_FILTER_OPTIONS: ReadonlyArray<{
  filter: CatalogFilter;
  label: string;
}> = CATALOG_FILTERS.map((filter) => ({
  filter,
  label: CATALOG_LENSES[filter].label,
}));

/**
 * The profiles the list renders: the search box and the lens decide WHICH rows,
 * the sort decides in what ORDER. With no explicit sort each lens reads in its
 * own worst-first order (least covered, least trustworthy, oldest cut-off);
 * `state.sort` overrides that in any lens, «todos» included.
 *
 * `today` is a parameter, never the clock (ADR 0036 §7): the module stays pure
 * and the page decides what day it is.
 */
export function visibleProfiles(
  profiles: readonly GlobalExposureProfile[],
  state: Pick<CatalogViewState, "filter" | "query" | "sort">,
  today: string,
): GlobalExposureProfile[] {
  const needle = state.query.trim().toLowerCase();
  const lens = CATALOG_LENSES[state.filter];
  const compare = CATALOG_COMPARATORS[state.sort ?? lens.defaultSort];

  return profiles
    .filter((profile) => matchesQuery(profile, needle) && lens.matches(profile, today))
    .sort((a, b) => {
      const ordered = compare(a, b);
      return ordered !== 0 ? ordered : byKey(a, b);
    });
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
  if (state.sort !== null) {
    params.set("orden", state.sort);
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

/** An unknown `orden` falls back to the lens's own order, not to an error. */
function parseCatalogSort(value: string | null | undefined): CatalogSort | null {
  return CATALOG_SORTS.find((sort) => sort === value) ?? null;
}

/** Parse view state from URL search params (deep-link + reload). */
export function parseCatalogParams(params: {
  filtro?: string | null;
  orden?: string | null;
  q?: string | null;
  perfil?: string | null;
}): CatalogViewState {
  return {
    filter: parseCatalogFilter(params.filtro),
    sort: parseCatalogSort(params.orden),
    query: typeof params.q === "string" ? params.q : "",
    selectedKey: params.perfil ? params.perfil : null,
  };
}
