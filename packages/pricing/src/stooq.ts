import type { PriceProvider } from "./index";

export const stooqProvider: PriceProvider = {
  name: "stooq",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    const url =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(ctx.symbol) +
      "&f=sd2t2ohlcv&h&e=csv";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = (lines[1] ?? "").split(",");
    const date = (parts[1] ?? "").trim();
    const close = (parts[6] ?? "").trim();
    if (!close || close === "N/D") return null;
    return date
      ? { price: close, currency: "EUR", priceDate: date }
      : { price: close, currency: "EUR" };
  },
};
