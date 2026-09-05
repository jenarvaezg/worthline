import type { ExposureProfile } from "./exposure-lookthrough";
import type { GlobalExposureProfile } from "./global-exposure-profile";
import { defaultsFor, type Instrument } from "./instrument-catalog";
import { INVESTMENT_PRICE_PROVIDERS, type InvestmentPriceProvider } from "./prices";
import {
  classifySecurityId,
  normalizedSecurityIdColumnValue,
  type SecurityId,
  validIsinOrNull,
} from "./security-id";

export { isValidIsin, validIsinOrNull } from "./security-id";

/**
 * The identity of an exposure-catalog row (#940, #1097, ADR 0058): a security is
 * identified by its typed security id (ISIN or DGS), or its price provider +
 * symbol when unidentified. Legacy callers retain validated ISIN/provider
 * behavior until #1743/#1745. This module owns catalog and lookup keys;
 * security-id owns identifier validation.
 */
export type GlobalExposureProfileIdentity =
  | { kind: "isin"; isin: string }
  | { kind: "dgs"; code: string }
  | {
      kind: "provider";
      priceProvider: InvestmentPriceProvider;
      providerSymbol: string;
    };

export interface RawGlobalExposureProfileIdentityInput {
  /** Undefined reads legacy isin; null explicitly declares no security id. */
  securityId?: SecurityId | null;
  isin?: string | null;
  priceProvider?: string | null;
  providerSymbol?: string | null;
}

/**
 * The instruments that carry a look-through exposure profile — the equity/fund
 * family keyed by security id or provider symbol. The single source of truth for "is
 * this a market holding with a catalog identity": both `resolveProfile`
 * (look-through) and {@link deriveExposureCatalogIdentity} (#1097) read it, so
 * the set that gets a profile lookup and the set that registers a catalog stub
 * never drift.
 */
export const INVESTMENT_PROFILE_INSTRUMENTS: ReadonlySet<Instrument> =
  new Set<Instrument>(["fund", "etf", "stock", "index", "pension_plan"]);

/** The provider vocabulary as a set, derived from the single list in `./prices`. */
const PROVIDER_SET: ReadonlySet<InvestmentPriceProvider> = new Set(
  INVESTMENT_PRICE_PROVIDERS,
);

/**
 * The providers a look-through instrument can carry. Deliberately excludes
 * `coingecko`: only crypto is priced by it, and crypto is not a look-through
 * instrument (it has no underlying to see through). So a coingecko-priced holding
 * never auto-derives a catalog identity — which is what keeps the instrument-
 * omitted branch from registering a crypto row when the instrument is unknown.
 */
const LOOKTHROUGH_PRICE_PROVIDERS: ReadonlySet<InvestmentPriceProvider> =
  new Set<InvestmentPriceProvider>(["yahoo", "stooq", "finect"]);

function isLookthroughProvider(value: string): value is InvestmentPriceProvider {
  return LOOKTHROUGH_PRICE_PROVIDERS.has(value as InvestmentPriceProvider);
}

/**
 * Exactly one key per typed state: ISIN value, dgs:code, or provider symbol for
 * explicit null. An invalid typed declaration yields null, never another key.
 * Only callers omitting securityId use the legacy validated ISIN/provider rule
 * (#1453). The catalog adapter shares this boundary with holding lookups.
 */
export function exposureLookthroughKey(source: {
  /** Undefined uses the legacy ISIN path; null explicitly selects the symbol. */
  securityId?: SecurityId | null;
  isin?: string | null;
  providerSymbol?: string | null;
}): string | null {
  if (source.securityId !== undefined) {
    if (source.securityId === null) return trimToNull(source.providerSymbol);
    const securityId = normalizedDeclaredSecurityId(source.securityId);
    if (!securityId) return null;
    return securityId.kind === "isin" ? securityId.value : `dgs:${securityId.value}`;
  }
  return validIsinOrNull(source.isin) ?? trimToNull(source.providerSymbol);
}

function normalizedDeclaredSecurityId(securityId: SecurityId): SecurityId | null {
  const classified = classifySecurityId(securityId.value);
  return classified?.kind === securityId.kind ? classified : null;
}

/**
 * The composite key the catalog persists a row under: the ISIN itself for an
 * ISIN identity, `dgs:code` for DGS, or `p:provider:symbol` for a provider identity (so
 * the same symbol under two providers stays distinct). This is the storage key,
 * not the look-through key — see {@link exposureLookthroughKey}.
 */
export function globalExposureProfileIdentityKey(
  identity: GlobalExposureProfileIdentity,
): string {
  switch (identity.kind) {
    case "isin":
      return identity.isin;
    case "dgs":
      return `dgs:${identity.code}`;
    case "provider":
      return `p:${identity.priceProvider}:${identity.providerSymbol}`;
  }
}

/**
 * Parse an admin-supplied raw identity into the tagged {@link
 * GlobalExposureProfileIdentity}. Typed declarations validate only their kind;
 * explicit null selects provider + symbol. Legacy input keeps its valid-ISIN
 * priority. Throws when the selected identity is invalid or absent.
 */
export function resolveGlobalExposureProfileIdentity(
  input: RawGlobalExposureProfileIdentityInput,
): GlobalExposureProfileIdentity {
  if (input.securityId != null) {
    const value = normalizedSecurityIdColumnValue(
      input.securityId.kind,
      input.securityId.value,
    );
    if (!value) throw new Error("Introduce un identificador de valor.");
    return securityIdCatalogIdentity({ kind: input.securityId.kind, value });
  }
  const isin = input.securityId === undefined ? validIsinOrNull(input.isin) : null;
  if (isin) {
    return { isin, kind: "isin" };
  }

  const priceProvider = trimToNull(input.priceProvider);
  const providerSymbol = trimToNull(input.providerSymbol);
  if (priceProvider && providerSymbol) {
    return {
      kind: "provider",
      priceProvider: assertInvestmentPriceProvider(priceProvider),
      providerSymbol,
    };
  }

  throw new Error(
    "Exposure profile identity requires a valid ISIN, DGS code or priceProvider + providerSymbol.",
  );
}

function securityIdCatalogIdentity(
  securityId: SecurityId,
): GlobalExposureProfileIdentity {
  return securityId.kind === "isin"
    ? { kind: "isin", isin: securityId.value }
    : { kind: "dgs", code: securityId.value };
}

/**
 * The global exposure-catalog identity a holding registers under, derived from
 * its own stored fields (#1097, ADR 0058). This is the pure half of "the catalog
 * row is born with the holding": a market holding resolves to an
 * {@link GlobalExposureProfileIdentity}; anything else resolves to `null` and is
 * never registered.
 *
 * The identity mirrors the look-through key {@link exposureLookthroughKey}
 * (one key per typed state) so the stub the admin later curates is the very row
 * the aggregation reads. Only the equity/fund family has one — cash, property,
 * crypto, coins and vehicles carry no GICS-catalog identity, so connected sources
 * (which yield only crypto/coins today) naturally register nothing.
 */
export interface ExposureCatalogIdentitySource {
  /** Undefined reads legacy isin; null explicitly declares no security id. */
  securityId?: SecurityId | null;
  /**
   * The holding's instrument. When present it gates registration to the market
   * set (creation paths, where the instrument is known). Omit it only when the
   * caller already knows the holding is a market investment but does not carry
   * the instrument — e.g. a statement backfill onto an `InvestmentAssetFull`,
   * which is a market investment by construction and supplies `priceProvider`.
   */
  instrument?: Instrument | null;
  isin?: string | null;
  providerSymbol?: string | null;
  /** Explicit provider when the holding stores one; else the instrument default. */
  priceProvider?: string | null;
}

export function deriveExposureCatalogIdentity(
  source: ExposureCatalogIdentitySource,
): GlobalExposureProfileIdentity | null {
  // A known non-market instrument never registers. When the instrument is absent
  // the caller has asserted a market investment (see the interface doc); the
  // provider gate below still rejects crypto (coingecko), so a mislabeled crypto
  // holding cannot slip through that path either.
  if (
    source.instrument != null &&
    !INVESTMENT_PROFILE_INSTRUMENTS.has(source.instrument)
  ) {
    return null;
  }

  if (source.securityId != null) {
    const securityId = normalizedDeclaredSecurityId(source.securityId);
    return securityId ? securityIdCatalogIdentity(securityId) : null;
  }
  const isin = source.securityId === undefined ? validIsinOrNull(source.isin) : null;
  if (isin) {
    return { isin, kind: "isin" };
  }

  const providerSymbol = (source.providerSymbol ?? "").trim();
  if (!providerSymbol) {
    return null;
  }

  // Prefer an explicit stored provider, but only when it is a look-through one;
  // otherwise fall back to the instrument's default (fund/etf/stock/index → yahoo,
  // pension_plan → finect). A coingecko provider (crypto) resolves to neither and
  // yields no identity.
  const explicit = (source.priceProvider ?? "").trim();
  const fallback =
    source.instrument != null ? defaultsFor(source.instrument).priceProvider : null;
  const priceProvider = explicit && isLookthroughProvider(explicit) ? explicit : fallback;
  if (!priceProvider || !isLookthroughProvider(priceProvider)) {
    return null;
  }

  return { kind: "provider", priceProvider, providerSymbol };
}

/**
 * Adapt global-catalog profiles (PRD #711, ADR 0058) into the look-through's
 * per-security map, keyed by {@link exposureLookthroughKey} — the exact key a
 * holding resolves with in `lookThroughExposure` / `resolveAssetClassBreakdown`.
 * The catalog is the source of truth; the provenance fields the aggregation never
 * reads default to `source:"user"` / `declaredAt:null`, and a profile hedged to
 * any currency suppresses currency risk (`hedged:true`).
 */
export function exposureProfileLookthroughMap(
  profiles: readonly GlobalExposureProfile[],
): Map<string, ExposureProfile> {
  const map = new Map<string, ExposureProfile>();
  for (const profile of profiles) {
    const key = exposureLookthroughKey(
      profile.identity.kind === "isin"
        ? { securityId: { kind: "isin", value: profile.identity.isin } }
        : profile.identity.kind === "dgs"
          ? { securityId: { kind: "dgs", value: profile.identity.code } }
          : { securityId: null, providerSymbol: profile.identity.providerSymbol },
    );
    if (!key) {
      continue;
    }
    map.set(key, {
      key,
      source: "user",
      declaredAt: null,
      trackedIndex: profile.trackedIndex,
      ter: profile.ter,
      hedged: profile.hedgedToCurrency !== null,
      breakdowns: profile.breakdowns,
    });
  }
  return map;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function assertInvestmentPriceProvider(value: string): InvestmentPriceProvider {
  if (!PROVIDER_SET.has(value as InvestmentPriceProvider)) {
    throw new Error(`Unknown price provider "${value}".`);
  }
  return value as InvestmentPriceProvider;
}
