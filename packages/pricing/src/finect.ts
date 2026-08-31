import { convertPriceToEur } from "./convert-to-eur";
import { fetchHttpWithRetry } from "./fetch-with-retry";
import { PRICE_FAILURE_REASONS, type PriceProvider } from "./index";

// One base URL covers both product sections: `/planes-pensiones/<slug>`
// 301-redirects to `/fondos-inversion/<slug>` for a fund, and `fetch` follows it.
const FINECT_PRODUCT_URL = "https://www.finect.com/planes-pensiones/";
const FINECT_API_BASE_URL = "https://api.finect.com/v4/";
// Finect's own public frontend key (the `key` header their website sends to
// api.finect.com), not a credential we registered — so it's intentionally
// inline, not a secret to rotate or move to env. Only used for the read-only
// pension-code → ISIN/alias lookup below. It may stop working if Finect rotates
// it; `resolveFinectPlanSymbolByCode` already degrades to null on any non-OK
// response, so that failure mode is handled.
const FINECT_API_KEY = "OgcqanUxQ4S6Y5VVvnwlJayUuxeg8Ah5";

/** A NAV as Finect publishes it: native amount plus its declared currency. */
export interface FinectQuote {
  price: string;
  currency: string;
  priceDate?: string;
}

export const finectProvider: PriceProvider = {
  name: "finect",
  fetchPrice: async (ctx) => {
    const res = await fetchHttpWithRetry(
      FINECT_PRODUCT_URL + encodeURIComponent(ctx.symbol),
    );

    if (!res.ok) {
      return { failed: true, reason: PRICE_FAILURE_REASONS.httpError(res.status) };
    }

    const html = await res.text();
    const quote = parseFinectQuote(html);

    if (!quote) {
      // Finect's `Producto no disponible` soft-404 is a dead symbol (permanent);
      // a product page we simply cannot read is a layout change (transient), and
      // must not discard a good cached price.
      return isProductoNoDisponible(html)
        ? { failed: true, reason: PRICE_FAILURE_REASONS.symbolNotFound }
        : { failed: true, reason: PRICE_FAILURE_REASONS.unreadableQuote };
    }

    // Funds are often denominated in USD (issue #1357). Passing that figure off
    // as EUR doubled a position's value, so an unavailable rate is a failure,
    // never a 1:1 pass-through.
    const priceInEur = await convertPriceToEur(quote.price, quote.currency, ctx);

    if (!priceInEur) {
      return {
        failed: true,
        reason: PRICE_FAILURE_REASONS.fxUnavailable(quote.currency),
      };
    }

    return {
      price: priceInEur,
      currency: "EUR",
      ...(quote.priceDate ? { priceDate: quote.priceDate } : {}),
    };
  },
};

/**
 * Resolve a Finect product symbol (the slug after `/planes-pensiones/` or
 * `/fondos-inversion/`, e.g. `N5394-Myinvestor` or
 * `IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc`) to its name and current
 * NAV **in its own currency**. Returns null for a missing product or Finect's
 * `Producto no disponible` soft-404 page (HTTP 200 with no offer) — the absence
 * of a parseable NAV is the signal that the symbol does not resolve.
 */
export async function resolveFinectProduct(symbol: string): Promise<
  | (FinectQuote & {
      symbol: string;
      name: string;
    })
  | null
> {
  const res = await fetchHttpWithRetry(FINECT_PRODUCT_URL + encodeURIComponent(symbol));

  if (!res.ok) return null;

  const html = await res.text();
  const quote = parseFinectQuote(html);

  if (!quote) return null;

  return {
    symbol,
    name: parseFinectName(html) ?? symbol,
    ...quote,
  };
}

interface FinectPlanApiResponse {
  data?: {
    alias?: string;
    isin?: string;
  };
}

export async function resolveFinectPlanSymbolByCode(
  code: string,
): Promise<string | null> {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^[A-Z]?\d{3,}$/.test(normalizedCode)) return null;

  const res = await fetchHttpWithRetry(
    `${FINECT_API_BASE_URL}products/collectives/plans/${encodeURIComponent(normalizedCode)}`,
    {
      headers: {
        Accept: "application/json",
        key: FINECT_API_KEY,
      },
    },
  );

  if (!res.ok) return null;

  const payload = (await res.json()) as FinectPlanApiResponse;
  const isin = payload.data?.isin ?? normalizedCode;
  const alias = payload.data?.alias;

  return alias ? `${isin}-${alias}` : null;
}

interface FinectJsonLd {
  offers?: {
    price?: unknown;
    priceCurrency?: unknown;
  };
  additionalProperty?: Array<{ name?: unknown; value?: unknown }>;
}

/**
 * Read the NAV from the page's schema.org `InvestmentFund` payload.
 *
 * The visible label is NOT a viable source (issue #1357): scraping the first
 * `<digits> €` out of the flattened HTML matched `%20Europa` on a USD fund
 * (a URL-encoded space plus the start of "Europa" → a 20 € NAV) and `%22euribor`
 * on the soft-404 page (→ 22 €). The JSON-LD offer is unambiguous, carries the
 * declared currency, and keeps the full precision the label rounds away
 * (21,64353 vs 21,64).
 */
function parseFinectQuote(html: string): FinectQuote | null {
  const payload = parseFinectJsonLd(html);
  if (!payload) return null;

  const price = normalizeOfferPrice(payload.offers?.price);
  const currency =
    normalizeCurrency(payload.offers?.priceCurrency) ?? declaredCurrency(payload);

  // A NAV without a declared currency is unusable: assuming EUR is exactly the
  // bug this parser exists to prevent.
  if (!price || !currency) return null;

  const priceDate = parseFinectNavDate(html);

  return {
    price,
    currency,
    ...(priceDate ? { priceDate } : {}),
  };
}

/**
 * The product payload among the page's JSON-LD blocks — picked by having an
 * `offers`, not by being first. Finect serves a single block today, but the day
 * it prepends a `BreadcrumbList` (or wraps everything in a `@graph`), taking
 * block zero would fail EVERY Finect symbol at once, and transiently: prices
 * would quietly age instead of raising anything.
 */
function parseFinectJsonLd(html: string): FinectJsonLd | null {
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    if (!block[1]) continue;

    try {
      const parsed: unknown = JSON.parse(block[1]);
      const candidates = flattenJsonLd(parsed);
      const product = candidates.find((entry) => entry.offers !== undefined);
      if (product) return product;
    } catch {
      // A malformed block is not the end of the page: try the next one.
    }
  }

  return null;
}

/** Unwrap the three shapes schema.org allows: a node, an array, a `@graph`. */
function flattenJsonLd(parsed: unknown): FinectJsonLd[] {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenJsonLd);
  if (typeof parsed !== "object" || parsed === null) return [];

  const node = parsed as FinectJsonLd & { "@graph"?: unknown };

  return node["@graph"] === undefined ? [node] : [node, ...flattenJsonLd(node["@graph"])];
}

/**
 * schema.org offers state the price with a `.` decimal separator, so the raw
 * string is kept (full precision, no float round-trip). A comma-formatted price
 * is REJECTED rather than guessed at: `1,234` is 1,234 in Madrid and 1234 in
 * London, and this parser exists because a guessed figure doubled a position.
 */
function normalizeOfferPrice(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return null;

  return String(value).trim();
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const currency = value.trim().toUpperCase();

  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/** Fallback for offers that omit `priceCurrency`: the page's `Divisa` property. */
function declaredCurrency(payload: FinectJsonLd): string | null {
  const property = payload.additionalProperty?.find(
    (entry) =>
      typeof entry?.name === "string" && entry.name.trim().toLowerCase() === "divisa",
  );

  return normalizeCurrency(property?.value);
}

/**
 * Finect's soft-404: HTTP 200 with `Producto no disponible` as the page's own
 * heading. Matched on the title and the `<h1>` only — never on the whole body,
 * where an unrelated widget could carry the phrase and turn a live product into
 * a dead symbol.
 */
function isProductoNoDisponible(html: string): boolean {
  const headline = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";

  return /producto no disponible/i.test(`${parseFinectName(html) ?? ""} ${headline}`);
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

/**
 * The NAV date stamp, or null when the page does not carry a real one.
 *
 * The regex bounds the digits, not the calendar (issue #1380): `31/02/2026`
 * used to sail through and be stored — and shown back to the user as
 * `31/02/2026` — as a day February does not have. A stamp we cannot trust is
 * dropped, never the price: `fetchPrice` and `resolveFinectProduct` both spread
 * `priceDate` conditionally, and the assistant already says "sin fecha del
 * proveedor". An unreadable stamp does not make the NAV any less true.
 */
function parseFinectNavDate(html: string): string | null {
  const text = toPlainText(html);
  const match = text.match(
    /Fecha de valor liquidativo\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );

  if (!match?.[1] || !match[2] || !match[3]) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Round-trip through UTC: out-of-range components roll over silently
  // (Feb 31 → Mar 3, month 25 → next year), so only a date whose parts survive
  // intact is one the calendar actually has.
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function toPlainText(html: string): string {
  return html
    .replace(/&euro;/gi, "€")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
