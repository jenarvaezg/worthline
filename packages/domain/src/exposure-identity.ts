import type { ExposureProfile } from "./exposure-lookthrough";
import type { GlobalExposureProfile } from "./global-exposure-profile";
import { defaultsFor, type Instrument } from "./instrument-catalog";
import type { InvestmentPriceProvider } from "./prices";

/**
 * The identity of an exposure-catalog row (#940, #1097, ADR 0058): a security is
 * identified by its ISIN when it has one, otherwise by its price
 * provider + symbol. This module is the single home of that rule — the type, the
 * ISIN checksum, the key functions, the raw-input and holding derivations, and
 * the catalog→look-through adapter. The look-through and the global-catalog
 * modules depend on it rather than restating "ISIN else provider symbol".
 */
export type GlobalExposureProfileIdentity =
  | { kind: "isin"; isin: string }
  | {
      kind: "provider";
      priceProvider: InvestmentPriceProvider;
      providerSymbol: string;
    };

export interface RawGlobalExposureProfileIdentityInput {
  isin?: string | null;
  priceProvider?: string | null;
  providerSymbol?: string | null;
}

/**
 * The instruments that carry a look-through exposure profile — the equity/fund
 * family keyed by `isin ?? providerSymbol`. The single source of truth for "is
 * this a market holding with a catalog identity": both `resolveProfile`
 * (look-through) and {@link deriveExposureCatalogIdentity} (#1097) read it, so
 * the set that gets a profile lookup and the set that registers a catalog stub
 * never drift.
 */
export const INVESTMENT_PROFILE_INSTRUMENTS: ReadonlySet<Instrument> =
  new Set<Instrument>(["fund", "etf", "stock", "index", "pension_plan"]);

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const INVESTMENT_PRICE_PROVIDERS = new Set<InvestmentPriceProvider>([
  "yahoo",
  "stooq",
  "finect",
  "coingecko",
]);

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
 * The look-through key a holding resolves under and the catalog keys a profile
 * on: the ISIN when present, else the raw provider symbol — never the
 * `p:provider:symbol` composite {@link globalExposureProfileIdentityKey} stores
 * internally. The single definition of the "ISIN else provider symbol" rule:
 * `resolveProfile` (holding side) and {@link exposureProfileLookthroughMap}
 * (catalog side) both read it, so the two sides can never key differently.
 */
export function exposureLookthroughKey(source: {
  isin?: string | null;
  providerSymbol?: string | null;
}): string | null {
  return source.isin ?? source.providerSymbol ?? null;
}

/**
 * The composite key the catalog persists a row under: the ISIN itself for an
 * ISIN identity, or a `p:provider:symbol` composite for a provider identity (so
 * the same symbol under two providers stays distinct). This is the storage key,
 * not the look-through key — see {@link exposureLookthroughKey}.
 */
export function globalExposureProfileIdentityKey(
  identity: GlobalExposureProfileIdentity,
): string {
  return identity.kind === "isin"
    ? identity.isin
    : `p:${identity.priceProvider}:${identity.providerSymbol}`;
}

export function isValidIsin(value: string): boolean {
  if (!ISIN_PATTERN.test(value)) {
    return false;
  }

  const expanded = [...value]
    .map((character) => {
      if (character >= "0" && character <= "9") {
        return character;
      }
      return String(character.charCodeAt(0) - 55);
    })
    .join("");

  let sum = 0;
  let alternate = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    let digit = Number(expanded[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/**
 * Parse an admin-supplied raw identity into the tagged {@link
 * GlobalExposureProfileIdentity}: a valid ISIN wins (normalized upper-case),
 * else a price provider + symbol pair. Throws when neither resolves.
 */
export function resolveGlobalExposureProfileIdentity(
  input: RawGlobalExposureProfileIdentityInput,
): GlobalExposureProfileIdentity {
  const trimmedIsin = trimToNull(input.isin);
  if (trimmedIsin) {
    const normalized = trimmedIsin.toUpperCase();
    if (isValidIsin(normalized)) {
      return { isin: normalized, kind: "isin" };
    }
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
    "Exposure profile identity requires a valid ISIN or priceProvider + providerSymbol.",
  );
}

/**
 * The global exposure-catalog identity a holding registers under, derived from
 * its own stored fields (#1097, ADR 0058). This is the pure half of "the catalog
 * row is born with the holding": a market holding resolves to an
 * {@link GlobalExposureProfileIdentity}; anything else resolves to `null` and is
 * never registered.
 *
 * The identity mirrors the look-through key {@link exposureLookthroughKey}
 * (`isin ?? providerSymbol`) so the stub the admin later curates is the very row
 * the aggregation reads. Only the equity/fund family has one — cash, property,
 * crypto, coins and vehicles carry no GICS-catalog identity, so connected sources
 * (which yield only crypto/coins today) naturally register nothing.
 */
export interface ExposureCatalogIdentitySource {
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

  // ISIN is the stronger identity — the look-through prefers it over the symbol.
  const isin = (source.isin ?? "").trim().toUpperCase();
  if (isin && isValidIsin(isin)) {
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
        ? { isin: profile.identity.isin }
        : { providerSymbol: profile.identity.providerSymbol },
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
  if (!INVESTMENT_PRICE_PROVIDERS.has(value as InvestmentPriceProvider)) {
    throw new Error(`Unknown price provider "${value}".`);
  }
  return value as InvestmentPriceProvider;
}
