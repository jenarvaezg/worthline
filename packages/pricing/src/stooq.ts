import { fetchHttpWithRetry } from "./fetch-with-retry";
import { PRICE_FAILURE_REASONS, type PriceProvider } from "./index";
import { resolveProvider } from "./registry";

/**
 * Infer the quote currency for a Stooq symbol from its exchange suffix.
 * Stooq uses lowercase suffixes: `.us` → USD, `.uk`/`.l` → GBP, else EUR.
 */
export function inferStooqQuoteCurrency(symbol: string): "EUR" | "USD" | "GBP" {
  const lower = symbol.trim().toLowerCase();
  if (lower.endsWith(".us")) return "USD";
  if (lower.endsWith(".uk") || lower.endsWith(".l")) return "GBP";
  return "EUR";
}

async function convertStooqPriceToEur(
  price: string,
  quoteCurrency: "EUR" | "USD" | "GBP",
  ctx: Parameters<PriceProvider["fetchPrice"]>[0],
): Promise<string | null> {
  if (quoteCurrency === "EUR") return price;

  const fx = await resolveProvider("ecb").fetchPrice({ ...ctx, symbol: quoteCurrency });
  if (!fx || "failed" in fx) return null;

  const converted = Number(price) * Number(fx.price);
  if (!Number.isFinite(converted)) return null;

  return String(Math.round((converted + Number.EPSILON) * 100000000) / 100000000);
}

export const stooqProvider: PriceProvider = {
  name: "stooq",
  fetchPrice: async (ctx) => {
    const url =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(ctx.symbol) +
      "&f=sd2t2ohlcv&h&e=csv";
    const res = await fetchHttpWithRetry(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { failed: true, reason: PRICE_FAILURE_REASONS.httpError(res.status) };
    }
    const text = await res.text();
    const lines = text.trim().split("\n");
    // Header only, no data row — Stooq does not know this symbol.
    if (lines.length < 2) {
      return { failed: true, reason: PRICE_FAILURE_REASONS.symbolNotFound };
    }
    const parts = (lines[1] ?? "").split(",");
    const date = (parts[1] ?? "").trim();
    const close = (parts[6] ?? "").trim();
    // Symbol resolved but no quote available (e.g. close = "N/D").
    if (!close || close === "N/D") {
      return { failed: true, reason: PRICE_FAILURE_REASONS.noQuote };
    }

    const quoteCurrency = inferStooqQuoteCurrency(ctx.symbol);
    const priceInEur = await convertStooqPriceToEur(close, quoteCurrency, ctx);
    if (priceInEur === null) return null;

    return date
      ? { price: priceInEur, currency: "EUR", priceDate: date }
      : { price: priceInEur, currency: "EUR" };
  },
};
