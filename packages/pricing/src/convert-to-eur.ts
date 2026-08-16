import type { PriceProviderContext } from "./index";
import { resolveProvider } from "./registry";

/**
 * Convert a provider quote into EUR through the ECB rate of the day (#1065:
 * never 1:1). Shared by every provider that can be handed a non-EUR instrument
 * — Yahoo listings on foreign exchanges, Finect funds denominated in USD
 * (#1357).
 *
 * Conversion is a PIPELINE, not a fallback: quote × rate must both succeed.
 * `null` means "no honest EUR figure", and the caller must surface a failure
 * rather than pass the native amount off as euros.
 */
export async function convertPriceToEur(
  price: string,
  currency: string,
  ctx: PriceProviderContext,
): Promise<string | null> {
  if (currency === "EUR") return price;

  // ECB resolves through the registry so no cross-provider import is buried in
  // this body (issue #243).
  const fx = await resolveProvider("ecb").fetchPrice({ ...ctx, symbol: currency });
  if (!fx || "failed" in fx) return null;

  const converted = Number(price) * Number(fx.price);
  if (!Number.isFinite(converted)) return null;

  return String(Math.round((converted + Number.EPSILON) * 100000000) / 100000000);
}
