import { PRICE_FAILURE_REASONS, type PriceProvider } from "./index";

const FINECT_BASE_URL = "https://www.finect.com/planes-pensiones/";

export const finectProvider: PriceProvider = {
  name: "finect",
  canFetch: (ctx) => Boolean(ctx.symbol),
  fetchPrice: async (ctx) => {
    const res = await fetch(FINECT_BASE_URL + encodeURIComponent(ctx.symbol), {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { failed: true, reason: PRICE_FAILURE_REASONS.httpError(res.status) };
    }

    const html = await res.text();
    const price = parseFinectNavPrice(html);

    // HTTP-OK but no parseable NAV — Finect's `Producto no disponible` soft-404.
    if (!price) {
      return { failed: true, reason: PRICE_FAILURE_REASONS.symbolNotFound };
    }

    const priceDate = parseFinectNavDate(html);

    return {
      price,
      currency: "EUR",
      ...(priceDate ? { priceDate } : {}),
    };
  },
};

/**
 * Resolve a Finect pension-plan symbol (the slug after
 * `/planes-pensiones/`, e.g. `N5394-Myinvestor`) to its plan name and current
 * NAV. Returns null for a missing plan or Finect's `Producto no disponible`
 * soft-404 page (HTTP 200 with no NAV) — the absence of a parseable NAV is the
 * signal that the symbol does not resolve to a real plan.
 */
export async function resolveFinectPlan(symbol: string): Promise<{
  symbol: string;
  name: string;
  price: string;
  priceDate?: string;
} | null> {
  const res = await fetch(FINECT_BASE_URL + encodeURIComponent(symbol), {
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;

  const html = await res.text();
  const price = parseFinectNavPrice(html);

  if (!price) return null;

  const priceDate = parseFinectNavDate(html);

  return {
    symbol,
    name: parseFinectName(html) ?? symbol,
    price,
    ...(priceDate ? { priceDate } : {}),
  };
}

function parseFinectName(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);

  if (!match?.[1]) return null;

  const name = match[1]
    .replace(/&amp;/g, "&")
    .replace(/\s*[-|]\s*Finect\s*$/i, "")
    .trim();

  return name || null;
}

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
