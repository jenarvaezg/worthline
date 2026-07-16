import { INVESTMENT_PROFILE_INSTRUMENTS } from "./exposure-lookthrough";
import {
  type GlobalExposureProfileIdentity,
  isValidIsin,
} from "./global-exposure-profile";
import { defaultsFor, type Instrument } from "./instrument-catalog";
import type { InvestmentPriceProvider } from "./prices";

/**
 * The global exposure-catalog identity a holding registers under, derived from
 * its own stored fields (#1097, ADR 0058). This is the pure half of "the catalog
 * row is born with the holding": a market holding resolves to an
 * {@link GlobalExposureProfileIdentity}; anything else resolves to `null` and is
 * never registered.
 *
 * The identity mirrors the look-through key `isin ?? providerSymbol`
 * ({@link INVESTMENT_PROFILE_INSTRUMENTS}) so the stub the admin later curates is
 * the very row the aggregation reads. Only the equity/fund family has one —
 * cash, property, crypto, coins and vehicles carry no GICS-catalog identity, so
 * connected sources (which yield only crypto/coins today) naturally register
 * nothing.
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
