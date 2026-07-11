import { fetchHttpWithRetry } from "./fetch-with-retry";
import type { PriceProvider } from "./index";

const ECB_EXR_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.";

interface EcbExrResponse {
  dataSets?: Array<{
    series?: Record<string, { observations?: Record<string, unknown[]> }>;
  }>;
  structure?: {
    dimensions?: {
      observation?: Array<{ values?: Array<{ id?: string }> }>;
    };
  };
}

export const ecbProvider: PriceProvider = {
  name: "ecb",
  fetchPrice: async (ctx) => {
    const url =
      ECB_EXR_URL + ctx.symbol + ".EUR.SP00.A?format=jsondata&lastNObservations=1";
    const res = await fetchHttpWithRetry(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as EcbExrResponse;
    const obs = data?.dataSets?.[0]?.series?.["0:0:0:0:0"]?.observations?.["0"];
    if (!obs?.[0]) return null;
    return { price: String(1 / Number(obs[0])), currency: "EUR" };
  },
};

/**
 * Daily EUR value of one unit of `currency` over [fromMs, toMs], keyed by
 * YYYY-MM-DD — the DATED counterpart of `ecbProvider` (which only ever reads the
 * latest observation). The historical backfill converts each Yahoo close with the
 * rate of ITS date, never today's. ECB publishes business days only; weekends and
 * holidays are simply absent (callers carry the previous rate forward). Never
 * throws — an outage or malformed payload degrades to an empty map.
 */
export async function fetchEcbDailyRatesEur(
  currency: string,
  fromMs: number,
  toMs: number,
): Promise<ReadonlyMap<string, number>> {
  const rates = new Map<string, number>();
  const startPeriod = new Date(fromMs).toISOString().slice(0, 10);
  const endPeriod = new Date(toMs).toISOString().slice(0, 10);
  const url =
    ECB_EXR_URL +
    encodeURIComponent(currency.trim()) +
    `.EUR.SP00.A?format=jsondata&startPeriod=${startPeriod}&endPeriod=${endPeriod}`;

  try {
    const res = await fetchHttpWithRetry(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return rates;

    const data = (await res.json()) as EcbExrResponse;
    const observations = data?.dataSets?.[0]?.series?.["0:0:0:0:0"]?.observations;
    const dates = data?.structure?.dimensions?.observation?.[0]?.values;
    if (!observations || !dates) return rates;

    for (const [index, values] of Object.entries(observations)) {
      const dateKey = dates[Number(index)]?.id;
      const rate = Number(values?.[0]);
      if (!dateKey || !Number.isFinite(rate) || rate <= 0) continue;
      // The EXR series quotes `currency` per EUR; invert to EUR per unit.
      rates.set(dateKey, 1 / rate);
    }
    return rates;
  } catch {
    return rates;
  }
}
