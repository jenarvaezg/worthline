import {
  BASE_CURRENCY,
  createMoneyConverter,
  type FxAggregation,
  type MoneyMinor,
} from "@worthline/domain";
import { resolveFxRateSnapshot } from "@worthline/pricing";

/**
 * Resolve the FX context an aggregation needs to count non-base-currency holdings
 * honestly (#1065). It is HARD-GATED on a foreign currency actually being present:
 *
 *   - all-EUR portfolio (today's only case — CONTEXT.md: "no FX layer, stays in
 *     EUR", and import rejects a non-EUR base) → returns `undefined`, so the GET
 *     stays strictly cache-only (#785/#788/#895): NO ECB call, no behavior change.
 *   - a foreign-currency holding present → one live ECB fetch for the currencies
 *     seen, at `asOf` (spot for today). This is the deliberate, conditional
 *     exception to cache-only, live only once a connector introduces non-EUR; a
 *     cron-cached FX series is the deferred follow-up (#884).
 *
 * A currency ECB cannot price yields no observation, so the converter reports it
 * unconvertible and the aggregation excludes-and-marks it — never a 1:1 guess.
 */
export async function resolveFxAggregation(
  values: ReadonlyArray<MoneyMinor>,
  asOf: string,
): Promise<FxAggregation | undefined> {
  const foreign = [
    ...new Set(
      values
        .map((value) => value.currency)
        .filter((currency) => currency && currency !== BASE_CURRENCY),
    ),
  ];
  if (foreign.length === 0) {
    return undefined;
  }

  const snapshot = await resolveFxRateSnapshot(foreign, asOf);
  return { asOf, converter: createMoneyConverter(snapshot) };
}
