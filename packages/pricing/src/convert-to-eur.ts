import type { PriceProviderContext } from "./index";
import { fetchPriceNow } from "./registry";

/** Eight decimals: the precision every provider price is rounded to. */
const PRICE_SCALE = 100_000_000;

/**
 * Convert a provider quote into EUR through the ECB rate of the day (#1065:
 * never 1:1). Shared by every provider that can be handed a non-EUR instrument
 * — Yahoo listings on foreign exchanges, Finect funds denominated in USD
 * (#1357).
 *
 * Conversion is a PIPELINE, not a fallback: quote × rate must both succeed.
 * `null` means "no honest EUR figure", and the caller must surface a failure
 * rather than pass the native amount off as euros. ECB is reached through
 * `fetchPriceNow`, the pure-fetch door onto the provider seam (ADR 0026), so no
 * cross-provider import is buried in this body (issue #243).
 *
 * Uses TODAY's rate, even for a quote carrying its own `priceDate` (a fund NAV
 * lags a day or two). The dated counterpart exists — `fetchEcbDailyRatesEur`,
 * used by the historical backfill — but a live quote is a present-time figure,
 * and Yahoo has always converted this way; a per-provider split would be worse
 * than the sub-percent drift it saves.
 */
export async function convertPriceToEur(
  price: string,
  currency: string,
  ctx: PriceProviderContext,
): Promise<string | null> {
  if (currency === "EUR") return price;

  const fx = await fetchPriceNow("ecb", { ...ctx, symbol: currency });
  if (!fx) return null;

  const converted = Number(price) * Number(fx.price);
  if (!Number.isFinite(converted)) return null;

  return String(Math.round((converted + Number.EPSILON) * PRICE_SCALE) / PRICE_SCALE);
}
