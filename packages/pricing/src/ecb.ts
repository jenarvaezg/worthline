import type { PriceProvider } from "./index";
import { fetchHttpWithRetry } from "./fetch-with-retry";

export const ecbProvider: PriceProvider = {
  name: "ecb",
  fetchPrice: async (ctx) => {
    const url =
      "https://data-api.ecb.europa.eu/service/data/EXR/D." +
      ctx.symbol +
      ".EUR.SP00.A?format=jsondata&lastNObservations=1";
    const res = await fetchHttpWithRetry(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const obs = (
      data?.dataSets as
        | Array<{
            series?: Record<string, { observations?: Record<string, unknown[]> }>;
          }>
        | undefined
    )?.[0]?.series?.["0:0:0:0:0"]?.observations?.["0"];
    if (!obs?.[0]) return null;
    return { price: String(1 / Number(obs[0])), currency: "EUR" };
  },
};
