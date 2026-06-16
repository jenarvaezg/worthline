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

/** The raw funding-wallet balance line (POST /sapi/v1/asset/get-funding-asset).
 *  `locked`/`freeze`/`withdrawing` are optional — Binance omits them when zero. */
interface RawFundingBalance {
  asset: string;
  free: string;
  locked?: string;
  freeze?: string;
  withdrawing?: string;
}

/** The raw flexible-Earn position row (GET /sapi/v1/simple-earn/flexible/position). */
interface RawFlexibleEarnRow {
  asset: string;
  totalAmount: string;
}

/** The raw locked-Earn position row (GET /sapi/v1/simple-earn/locked/position).
 *  Unlike flexible Earn the owned quantity is `amount`. */
interface RawLockedEarnRow {
  asset: string;
  amount: string;
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

/**
 * List the FUNDING-wallet balances (POST /sapi/v1/asset/get-funding-asset, SIGNED).
 * Same market-rung tokens as spot, just parked in the funding wallet (P2P / Pay /
 * card top-ups) — so they fold into the same live-valued holding (#247). The owned
 * quantity is `free + locked + freeze + withdrawing` — all still owned (an in-flight
 * `withdrawing` amount has left `free` but not yet the account), summed through the
 * decimal seam (Binance omits the optional buckets when zero) so a withdrawal in
 * progress doesn't make the holding dip. Zero balances are dropped; a non-2xx
 * throws a Binance-tagged error.
 */
export async function getFundingBalances(
  credentials: BinanceCredentials,
  deps: BinanceRequestDeps,
): Promise<BinanceWalletBalance[]> {
  const query = `timestamp=${deps.nowMs}`;
  const signature = signQuery(query, credentials.apiSecret);

  const res = await fetch(
    `${BINANCE_BASE}/sapi/v1/asset/get-funding-asset?${query}&signature=${signature}`,
    {
      method: "POST",
      headers: { "X-MBX-APIKEY": credentials.apiKey },
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!res.ok) {
    throw new Error(
      `Binance POST /sapi/v1/asset/get-funding-asset failed (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as RawFundingBalance[];
  return (data ?? [])
    .map((line) => ({
      asset: line.asset,
      wallet: "funding",
      balance: addUnits(
        addUnits(addUnits(line.free, line.locked ?? "0"), line.freeze ?? "0"),
        line.withdrawing ?? "0",
      ),
    }))
    .filter((line) => compareUnits(line.balance, "0") > 0);
}

/**
 * List the FLEXIBLE Earn balances (GET /sapi/v1/simple-earn/flexible/position,
 * SIGNED). Flexible Earn principal is still market-liquid (redeemable on demand),
 * so it folds into the same live-valued holding as spot + funding (#247). Each
 * row's owned quantity is its `totalAmount`. A non-2xx throws a Binance-tagged
 * error; zero balances are dropped.
 *
 * One page (size=100) is requested. Pagination beyond a single page is bounded and
 * intentionally out of scope here (a portfolio with >100 distinct Earn assets is
 * not a case this slice targets).
 */
export async function getFlexibleEarnBalances(
  credentials: BinanceCredentials,
  deps: BinanceRequestDeps,
): Promise<BinanceWalletBalance[]> {
  const query = `size=100&timestamp=${deps.nowMs}`;
  const signature = signQuery(query, credentials.apiSecret);

  const res = await fetch(
    `${BINANCE_BASE}/sapi/v1/simple-earn/flexible/position?${query}&signature=${signature}`,
    {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!res.ok) {
    throw new Error(
      `Binance GET /sapi/v1/simple-earn/flexible/position failed (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as { rows?: RawFlexibleEarnRow[] };
  return (data.rows ?? [])
    .map((row) => ({
      asset: row.asset,
      wallet: "flexible-earn",
      balance: addUnits(row.totalAmount, "0"),
    }))
    .filter((row) => compareUnits(row.balance, "0") > 0);
}

/**
 * List the LOCKED Earn / locked-staking balances (GET
 * /sapi/v1/simple-earn/locked/position, SIGNED). Unlike flexible Earn, locked Earn
 * principal is committed for a fixed term — redeemable only at maturity — so it
 * projects onto the **term-locked** rung, a SEPARATE holding from the market one
 * (ADR 0016/0021, S3). Each row's owned quantity is its `amount`. A non-2xx throws
 * a Binance-tagged error; zero balances are dropped.
 *
 * Binance folded most of what used to be "staking" under locked Earn (ETH 2.0
 * staking, DOT/ADA term products, …). Any on-chain / ETH-staking-specific endpoint
 * is bounded and intentionally out of scope here — locked Earn is the one
 * term-locked surface this slice mirrors. One page (size=100) is requested;
 * pagination beyond it is bounded and out of scope, as in flexible Earn.
 */
export async function getLockedEarnBalances(
  credentials: BinanceCredentials,
  deps: BinanceRequestDeps,
): Promise<BinanceWalletBalance[]> {
  const query = `size=100&timestamp=${deps.nowMs}`;
  const signature = signQuery(query, credentials.apiSecret);

  const res = await fetch(
    `${BINANCE_BASE}/sapi/v1/simple-earn/locked/position?${query}&signature=${signature}`,
    {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!res.ok) {
    throw new Error(
      `Binance GET /sapi/v1/simple-earn/locked/position failed (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as { rows?: RawLockedEarnRow[] };
  return (data.rows ?? [])
    .map((row) => ({
      asset: row.asset,
      wallet: "locked-earn",
      balance: addUnits(row.amount, "0"),
    }))
    .filter((row) => compareUnits(row.balance, "0") > 0);
}

/**
 * List ALL balances worthline mirrors: spot + funding + flexible Earn (market) +
 * locked Earn (term-locked), concatenated into one `BinanceWalletBalance[]`
 * (#247/#248). Each line keeps its `wallet` tag (origin metadata); the sync maps
 * that wallet to a liquidity rung (market vs term-locked), so a source spans rungs
 * — the first real exercise of ADR 0016's one-holding-per-rung projection. Futures
 * and margin are deliberately NOT fetched. Fetched sequentially — four calls per
 * sync stay well under the rate cap and keep the failure surface simple (any throw
 * aborts the whole sync; the action's catch leaves existing positions untouched).
 */
export async function getAllBalances(
  credentials: BinanceCredentials,
  deps: BinanceRequestDeps,
): Promise<BinanceWalletBalance[]> {
  const spot = await getSpotBalances(credentials, deps);
  const funding = await getFundingBalances(credentials, deps);
  const flexibleEarn = await getFlexibleEarnBalances(credentials, deps);
  const lockedEarn = await getLockedEarnBalances(credentials, deps);
  return [...spot, ...funding, ...flexibleEarn, ...lockedEarn];
}
