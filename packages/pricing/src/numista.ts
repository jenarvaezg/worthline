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

import {
  fetchHttpWithRetry,
  TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT,
} from "./fetch-with-retry";

const NUMISTA_BASE = "https://api.numista.com/v3";

/**
 * A non-2xx answer from Numista, carrying the status so the caller can tell WHAT
 * failed (#1761): the request it made, or the account it made it from. A plain
 * `Error` collapsed both into one message, which the valuation wiring then
 * collapsed further into `null` — and a dead provider was asked about every coin.
 */
export class NumistaRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NumistaRequestError";
  }
}

/**
 * What a failed Numista read was really about (#1761) — the ONE classification
 * both the cut decision and the user-facing sentence read, so the two can never
 * disagree about the same status.
 *
 * - `credentials` (401/403) — Numista refuses this account.
 * - `quota` (429) — the account's monthly request budget is spent (ADR 0017).
 * - `server` (5xx that survived its retries) — Numista itself is unwell.
 * - `silence` — no HTTP answer at all: a timeout, a DNS failure, a body that did
 *   not parse. Nothing was said about the item, so nothing can be concluded from it.
 * - `item` — an answer ABOUT the thing asked for: 404 for an issue Numista does
 *   not know, 400 for an id it will not accept.
 *
 * Every kind but `item` means no later read will be answered either.
 */
export type NumistaFailureKind = "credentials" | "quota" | "server" | "silence" | "item";

export function numistaFailureKind(err: unknown): NumistaFailureKind {
  if (!(err instanceof NumistaRequestError)) {
    return "silence";
  }
  if (err.status === 401 || err.status === 403) {
    return "credentials";
  }
  if (err.status === 429) {
    return "quota";
  }
  if (err.status >= 500) {
    return "server";
  }
  return "item";
}

/**
 * Whether a failed Numista read is the PROVIDER's — Numista has stopped answering
 * this account — rather than an answer about the one item asked for (#1761). Every
 * further read after a provider failure is a request spent for nothing, so a
 * valuation pass stops paying; an item failure only means that coin has no
 * estimate, and the pass moves on to the next one.
 *
 * A 400 counts as the ITEM's, deliberately, even though a systematic 400 (a
 * renamed query param on our side) would then spend the collection once per pass
 * — the very smell #1761 is about. Cutting on it would be worse: a single stored
 * issue id Numista will not accept would abort every pass at the same coin,
 * forever, and the collection would never finish being valued. A wrong request
 * shape is a bug to fix, not a budget to defend against.
 */
export function isNumistaProviderFailure(err: unknown): boolean {
  return numistaFailureKind(err) !== "item";
}

/**
 * The reason a failed valuation pass leaves on the collection's freshness row
 * (#1761), in the user's words: what happened, and what they can do about it. The
 * collection page and the connections page show it verbatim.
 */
const FAILURE_COPY: Record<NumistaFailureKind, string> = {
  credentials:
    "Numista rechazó la clave de API de la colección. Revísala en Ajustes → Conexiones.",
  quota:
    "Se ha agotado el cupo mensual de peticiones a Numista. La valoración se reintentará en la próxima pasada.",
  server:
    "Numista no responde (error de su servidor). La valoración se reintentará en la próxima pasada.",
  silence:
    "No se pudo actualizar la valoración de la colección Numista (revisa la conexión).",
  item: "No se pudo actualizar la valoración de la colección Numista (revisa la conexión).",
};

export function describeNumistaFailure(err: unknown): string {
  return FAILURE_COPY[numistaFailureKind(err)];
}

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

  // Retriable: `client_credentials` carries no nonce and no timestamp, so a
  // re-presented mint is the same request, not a stale one (contrast the signed
  // Binance calls). A blip here otherwise fails a whole collection sync.
  const res = await fetchHttpWithRetry(
    `${NUMISTA_BASE}/oauth_token`,
    {
      method: "POST",
      headers: {
        "Numista-API-Key": credentials.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    // Numista's quota is MONTHLY (2,000 requests, ADR 0017), so a 429 never clears
    // inside a 200/400 ms backoff: retrying it spends a second request to earn the
    // same answer (#1761). Server errors and timeouts still get their attempts.
    { retryStatuses: TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT },
  );

  if (!res.ok) {
    throw new NumistaRequestError(
      res.status,
      `Numista token mint failed (HTTP ${res.status}).`,
    );
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

/** One item in a user's collection (GET /users/{id}/collected_items) — a coin or a
 *  non-coin collectible (exonumia/banknote); `type.category` says which. The price
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
  /** The obverse photo's thumbnail URL — the catalogue image the coin gallery
   *  renders (#272 x100); null when the catalogue has no obverse photo. */
  obverseThumbUrl: string | null;
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
  const res = await fetchHttpWithRetry(
    `${NUMISTA_BASE}${path}`,
    { headers },
    // Numista's quota is MONTHLY (2,000 requests, ADR 0017), so a 429 never clears
    // inside a 200/400 ms backoff: retrying it spends a second request to earn the
    // same answer (#1761). Server errors and timeouts still get their attempts.
    { retryStatuses: TRANSIENT_HTTP_STATUSES_EXCEPT_RATE_LIMIT },
  );
  if (!res.ok) {
    throw new NumistaRequestError(
      res.status,
      `Numista GET ${path} failed (HTTP ${res.status}).`,
    );
  }
  return (await res.json()) as T;
}

/**
 * List ALL items in a user's collection (OAuth-gated): coins AND non-coin
 * collectibles — exonumia (medals, bullion rounds) and banknotes. They are
 * holdings with real value too, so the whole collection is mirrored with NO
 * `category` filter (#160 follow-up: a 1 oz silver round, which Numista files
 * under `exonumia`, was being silently dropped). Each item is valued by the same
 * metal/numismatic path regardless of category. Numista returns the whole
 * collection in one call — there is no pagination (spike #161).
 */
export async function getCollectedItems(
  credentials: NumistaCredentials,
  accessToken: string,
  userId: number,
): Promise<NumistaCollectedItem[]> {
  const data = await numistaGet<{ items?: NumistaCollectedItem[] }>(
    `/users/${userId}/collected_items?lang=${LANG}`,
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
    obverse?: { thumbnail?: string };
  }>(`/types/${typeId}?lang=${LANG}`, credentials.apiKey);
  return {
    title: data.title,
    compositionText: data.composition?.text ?? null,
    weightGrams: data.weight ?? null,
    obverseThumbUrl: data.obverse?.thumbnail ?? null,
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
 * The estimate reader BOTH valuation wirings inject — the on-demand collection
 * sync and the daily revalue (#1761). One reader, so the two can never again
 * disagree about what a failure means.
 *
 * It resolves `null` for a failure ABOUT THIS COIN (Numista has no estimate for
 * the issue, or will not accept the id): that is a legitimate answer, and the
 * caller moves on to the next coin. Anything else — rejected credentials, the
 * spent quota, Numista's own errors, silence — it RE-THROWS, because no later
 * read will be answered either and the caller must stop paying. Collapsing both
 * into `null` is what had a dead provider asked about all ~78 coins, every night,
 * for nothing.
 */
export function numistaPricesReader(
  credentials: NumistaCredentials,
): (typeId: number, issueId: number) => Promise<NumistaPrices | null> {
  return (typeId, issueId) =>
    getPrices(credentials, typeId, issueId).catch((err: unknown) => {
      if (isNumistaProviderFailure(err)) {
        throw err;
      }
      return null;
    });
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
  const normalized = grade.toLowerCase();
  const match = prices.find((entry) => entry.grade.toLowerCase() === normalized);
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
