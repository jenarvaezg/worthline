/**
 * Numista API client (PRD #160 / #163, ADR 0016/0017).
 *
 * A deep module encapsulating Numista's HTTP + OAuth behind a small interface.
 * Reading a user's collection requires an OAuth2 token: the `client_credentials`
 * grant with `scope=view_collection` reads your OWN collection non-interactively
 * (the API key alone 403s on collected_items). Per Numista's docs, that grant
 * authenticates "to your own account" with ONLY `grant_type` + `scope` — the
 * **API key (sent in the `Numista-API-Key` header) is the credential**; there is
 * no separate client_id/client_secret to register (in the authorization-code
 * flow Numista even defines `client_secret` AS the API key). The token lasts ~2h;
 * callers mint on demand and re-mint on expiry via {@link isTokenValid}.
 *
 * The API key lives in local config and is passed in; this module never reads env
 * or persists anything. The collected_items / coin-detail / prices readers are
 * added against the committed S0 fixtures (spike #161).
 */

const NUMISTA_BASE = "https://api.numista.com/v3";

/** Re-mint when fewer than this many ms remain, so a sync never races expiry. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * The credential worthline stores in local config (ADR 0016); never exported.
 * For the client_credentials self-read, the API key is the only field needed.
 */
export interface NumistaCredentials {
  apiKey: string;
}

/** A minted access token plus the epoch-ms instant it expires. */
export interface NumistaToken {
  accessToken: string;
  expiresAtMs: number;
  /** The authenticated user's Numista id (returned by the client_credentials
   *  grant), needed for the collection read. */
  userId: number;
}

/** The OAuth2 token response shape (RFC 6749 client_credentials grant). */
interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user_id: number;
}

/**
 * Mint a `client_credentials` token with `scope=view_collection` (ADR 0016).
 * `nowMs` is injected (never read from the clock) so the computed `expiresAtMs`
 * is deterministic and testable. Throws a Numista-tagged error on a non-2xx
 * response so the caller can surface a clear "check your credentials" message.
 */
export async function mintNumistaToken(
  credentials: NumistaCredentials,
  nowMs: number,
): Promise<NumistaToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "view_collection",
  });

  const res = await fetch(`${NUMISTA_BASE}/oauth_token`, {
    method: "POST",
    headers: {
      "Numista-API-Key": credentials.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Numista token mint failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    expiresAtMs: nowMs + data.expires_in * 1000,
    userId: data.user_id,
  };
}

/**
 * Whether a cached token is still usable at `nowMs`, with a safety margin so a
 * token about to expire is treated as already gone (the sync re-mints instead of
 * racing the boundary).
 */
export function isTokenValid(token: NumistaToken, nowMs: number): boolean {
  return token.expiresAtMs - TOKEN_SAFETY_MARGIN_MS > nowMs;
}

// ── Catalogue + collection readers ──────────────────────────────────────────

/** One coin in a user's collection (GET /users/{id}/collected_items). The price
 *  and acquisition_date fields are optional — present only when the user set them. */
export interface NumistaCollectedItem {
  id: number;
  quantity: number;
  type: { id: number; title: string; category?: string };
  // The coin's mint year lives on the issue (#215): `gregorian_year` is the
  // normalized Gregorian year, `year` the catalogue's own (possibly non-Gregorian).
  issue?: { id: number; year?: number; gregorian_year?: number };
  grade?: string;
  price?: { value: number; currency: string };
  acquisition_date?: string;
}

/** The value-relevant fields of a type (GET /types/{id}). */
export interface NumistaTypeDetail {
  title: string;
  /** Free-text composition, e.g. "Plata 999" / "Cuproníquel"; null when absent. */
  compositionText: string | null;
  /** Weight in grams; null when the catalogue has none. */
  weightGrams: number | null;
}

/** A per-grade price estimate (GET /types/{id}/issues/{issue}/prices). */
export interface NumistaPriceEntry {
  grade: string;
  price: number;
}

/** The prices response: estimates per grade in a single currency. */
export interface NumistaPrices {
  currency: string;
  prices: NumistaPriceEntry[];
}

const LANG = "es";

async function numistaGet<T>(path: string, apiKey: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Numista-API-Key": apiKey };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${NUMISTA_BASE}${path}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Numista GET ${path} failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as T;
}

/**
 * List the coins in a user's collection (OAuth-gated). Numista returns the whole
 * collection in one call — there is no pagination (spike #161). The `category`
 * filter narrows to coins.
 */
export async function getCollectedItems(
  credentials: NumistaCredentials,
  accessToken: string,
  userId: number,
): Promise<NumistaCollectedItem[]> {
  const data = await numistaGet<{ items?: NumistaCollectedItem[] }>(
    `/users/${userId}/collected_items?category=coin&lang=${LANG}`,
    credentials.apiKey,
    accessToken,
  );
  return data.items ?? [];
}

/** Fetch the value-relevant detail of a catalogue type (composition + weight). */
export async function getTypeDetail(
  credentials: NumistaCredentials,
  typeId: number,
): Promise<NumistaTypeDetail> {
  const data = await numistaGet<{
    title: string;
    composition?: { text?: string };
    weight?: number;
  }>(`/types/${typeId}?lang=${LANG}`, credentials.apiKey);
  return {
    title: data.title,
    compositionText: data.composition?.text ?? null,
    weightGrams: data.weight ?? null,
  };
}

/** Fetch the per-grade price estimates for one issue, in EUR (ADR 0017). */
export async function getPrices(
  credentials: NumistaCredentials,
  typeId: number,
  issueId: number,
): Promise<NumistaPrices> {
  return numistaGet<NumistaPrices>(
    `/types/${typeId}/issues/${issueId}/prices?currency=EUR&lang=${LANG}`,
    credentials.apiKey,
  );
}

/**
 * The numismatic estimate for a coin at its grade, in minor units, or null when
 * Numista has no estimate at that grade (no fabricated value — the valuation then
 * leans on metal or the purchase-price fallback).
 */
export function numismaticEstimateMinor(
  prices: readonly NumistaPriceEntry[],
  grade: string,
): number | null {
  const match = prices.find((entry) => entry.grade === grade.toLowerCase());
  return match ? Math.round(match.price * 100) : null;
}

/** The position fields derivable from a collected item alone (before the catalogue
 *  detail + price lookups that the sync layer adds). */
export interface CollectedItemDraft {
  catalogueId: string;
  issueId: number | null;
  name: string;
  grade: string;
  quantity: number;
  /** The coin's mint year from the issue (#215); null when the catalogue has none. */
  year: number | null;
  purchaseDate: string | null;
  purchasePriceMinor: number | null;
  currency: string;
}

/** Map a raw collected item to its position draft, reading the optional
 *  price/acquisition_date when the user recorded them (spike #161) and the coin's
 *  mint year (#215, gregorian_year preferred over the catalogue's own year). */
export function mapCollectedItem(item: NumistaCollectedItem): CollectedItemDraft {
  return {
    catalogueId: String(item.type.id),
    issueId: item.issue?.id ?? null,
    name: item.type.title,
    grade: item.grade ?? "",
    quantity: item.quantity,
    year: item.issue?.gregorian_year ?? item.issue?.year ?? null,
    purchaseDate: item.acquisition_date ?? null,
    purchasePriceMinor: item.price ? Math.round(item.price.value * 100) : null,
    currency: item.price?.currency ?? "EUR",
  };
}
