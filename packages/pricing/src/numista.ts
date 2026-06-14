/**
 * Numista API client (PRD #160 / #163, ADR 0016/0017).
 *
 * A deep module encapsulating Numista's HTTP + OAuth behind a small interface.
 * Reading a user's collection requires an OAuth2 token: the `client_credentials`
 * grant with `scope=view_collection` reads your OWN collection non-interactively
 * (the API key alone 403s on collected_items). The token lasts ~2h; callers mint
 * on demand and re-mint on expiry via {@link isTokenValid}.
 *
 * Credentials (API key + OAuth client id/secret) live in local config and are
 * passed in; this module never reads env or persists anything. The
 * collected_items / coin-detail / prices readers are added against the committed
 * S0 fixtures (spike #161).
 */

const NUMISTA_BASE = "https://api.numista.com/v3";

/** Re-mint when fewer than this many ms remain, so a sync never races expiry. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** The credentials worthline stores in local config (ADR 0016); never exported. */
export interface NumistaCredentials {
  apiKey: string;
  clientId: string;
  clientSecret: string;
}

/** A minted access token plus the epoch-ms instant it expires. */
export interface NumistaToken {
  accessToken: string;
  expiresAtMs: number;
}

/** The OAuth2 token response shape (RFC 6749 client_credentials grant). */
interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
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
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
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
