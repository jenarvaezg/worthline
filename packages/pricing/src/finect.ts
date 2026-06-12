import type { PriceProvider } from "./index";

const FINECT_BASE_URL = "https://www.finect.com/planes-pensiones/";

export const finectProvider: PriceProvider = {
  name: "finect",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    const res = await fetch(FINECT_BASE_URL + encodeURIComponent(ctx.symbol), {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    const html = await res.text();
    const price = parseFinectNavPrice(html);

    if (!price) return null;

    const priceDate = parseFinectNavDate(html);

    return {
      price,
      currency: "EUR",
      ...(priceDate ? { priceDate } : {}),
    };
  },
};

function parseFinectNavPrice(html: string): string | null {
  const text = toPlainText(html);
  const match = text.match(/(\d+(?:\.\d{3})*,\d+|\d+\.\d+|\d+)\s*(?:\u20ac|EUR)/i);

  if (!match?.[1]) return null;

  return match[1].replace(/\./g, "").replace(",", ".");
}

function parseFinectNavDate(html: string): string | null {
  const text = toPlainText(html);
  const match = text.match(
    /Fecha de valor liquidativo\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );

  if (!match?.[1] || !match[2] || !match[3]) return null;

  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");

  return `${match[3]}-${month}-${day}`;
}

function toPlainText(html: string): string {
  return html
    .replace(/&euro;/gi, "\u20ac")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
