import { PRICE_FAILURE_REASONS, type PriceProvider } from "./index";

export const stooqProvider: PriceProvider = {
  name: "stooq",
  fetchPrice: async (ctx) => {
    const url =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(ctx.symbol) +
      "&f=sd2t2ohlcv&h&e=csv";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
    return date
      ? { price: close, currency: "EUR", priceDate: date }
      : { price: close, currency: "EUR" };
  },
};
