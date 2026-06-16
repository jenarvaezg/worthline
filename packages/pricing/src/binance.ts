/**
 * Binance API client (ADR 0021).
 *
 * A deep module encapsulating Binance's HTTP + auth behind a small interface.
 * Binance SIGNED endpoints authenticate by signing the request query string with
 * **HMAC-SHA256** over the API secret — so, unlike Numista's OAuth, there is no
 * token to mint or cache (`tokenJson` stays null). The API key rides the
 * `X-MBX-APIKEY` header; the secret only ever signs (it is never sent).
 *
 * The credentials live in local config and are passed in; this module never reads
 * env or persists anything. Built over the global `fetch` (stubbed in tests, like
 * the Numista/CoinGecko clients); `nowMs` is injected so the signed timestamp is
 * deterministic and testable.
 */

import { createHmac } from "node:crypto";

import { addUnits, compareUnits } from "@worthline/domain";
import type { DecimalString } from "@worthline/domain";

const BINANCE_BASE = "https://api.binance.com";

/** Local-only credentials (ADR 0016): an API key + the signing secret. Never
 *  exported; the secret is more dangerous than Numista's read key (it can sign
 *  actions), so the connect form requires a READ-ONLY key. */
export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Injected reads for the signed calls — `nowMs` stamps the request timestamp. */
export interface BinanceRequestDeps {
  nowMs: number;
}

/** A normalized non-zero wallet balance: a token quantity on one Binance wallet. */
export interface BinanceWalletBalance {
  asset: string;
  /** Which Binance wallet this balance came from (`spot` in S1). */
  wallet: string;
  /** The owned quantity (free + locked-in-orders), as a decimal string. */
  balance: DecimalString;
}

/** The raw spot-account balance line (GET /api/v3/account). */
interface RawSpotBalance {
  asset: string;
  free: string;
  locked: string;
}

/**
 * The canonical HMAC-SHA256 hex signature of a query string under the API secret
 * — the credential Binance's SIGNED endpoints verify. Pure and deterministic.
 */
export function signQuery(query: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

/**
 * List the account's SPOT balances (GET /api/v3/account, SIGNED). Each asset's
 * owned quantity is `free + locked` — both are spot holdings (locked is tied up in
 * open orders, still owned, still market-liquid), so they sum into one balance.
 * Zero/dust balances are dropped so they never become positions. Throws a
 * Binance-tagged error on a non-2xx so the caller can surface "check your key".
 */
export async function getSpotBalances(
  credentials: BinanceCredentials,
  deps: BinanceRequestDeps,
): Promise<BinanceWalletBalance[]> {
  const query = `timestamp=${deps.nowMs}`;
  const signature = signQuery(query, credentials.apiSecret);

  const res = await fetch(
    `${BINANCE_BASE}/api/v3/account?${query}&signature=${signature}`,
    {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!res.ok) {
    throw new Error(`Binance GET /api/v3/account failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as { balances?: RawSpotBalance[] };
  return (data.balances ?? [])
    .map((line) => ({
      asset: line.asset,
      wallet: "spot",
      balance: addUnits(line.free, line.locked),
    }))
    .filter((line) => compareUnits(line.balance, "0") > 0);
}
