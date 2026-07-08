/**
 * Binance sync orchestration (ADR 0021).
 *
 * Turns the account's wallet balances into token-position drafts ready to persist.
 * For each balance it resolves the token's live EUR unit price (Binance symbol →
 * CoinGecko id → price); an unmapped or unpriceable token carries a **null** unit
 * price so the projection values it 0 and raises the "value at 0" warning (never
 * silently dropped). The price stored is a quote, not a value — the holding's
 * value is derived live as `balance × unitPrice` (ADR 0021).
 *
 * Every external dependency is injected, so this is a pure unit of work testable
 * without the network: the web action wires the real balance reader (signed) and a
 * CoinGecko EUR price fetch. Prices are deduped per CoinGecko id so a token held
 * across several wallets makes at most one price lookup.
 */

import type { DistributiveOmit, TokenPosition } from "@worthline/domain";

import { rungForWallet } from "./binance-rung";
import { isBinanceFiatEur, resolveCoinGeckoId } from "./binance-symbols";
import { coingeckoBaseUrl, coingeckoHeaders } from "./coingecko";
import { fetchPriceNow } from "./registry";

/** A token position ready to persist — the store assigns its id + sourceId. */
export type TokenPositionDraft = DistributiveOmit<TokenPosition, "id" | "sourceId">;

/** The external reads the sync needs, injected for testability. */
export interface BinanceSyncDeps {
  /** List the account's non-zero wallet balances (spot in S1; funding + flexible
   *  Earn fold in at S2; locked Earn on the term-locked rung at S3). */
  listBalances: () => Promise<{ asset: string; wallet: string; balance: string }[]>;
  /** The live EUR price for a CoinGecko id, or null on a miss/outage. */
  priceEur: (coingeckoId: string) => Promise<number | null>;
  /** Resolve each CoinGecko id's logo URL in ONE batched call (#482); a missing id
   *  or an outage yields a null/absent entry → the listing falls back to a glyph.
   *  Optional: a sync wired without it leaves every token's logo null. */
  logoUrls?: (coingeckoIds: readonly string[]) => Promise<Record<string, string | null>>;
}

export async function syncBinanceAccount(
  deps: BinanceSyncDeps,
): Promise<TokenPositionDraft[]> {
  const balances = await deps.listBalances();

  // Resolve each balance's CoinGecko id once (null when the symbol is unmapped).
  const idByLine = balances.map((line) =>
    isBinanceFiatEur(line.asset) ? "__fiat_eur__" : resolveCoinGeckoId(line.asset),
  );
  const distinctIds = [
    ...new Set(
      idByLine.filter((id): id is string => id !== null && id !== "__fiat_eur__"),
    ),
  ];

  // One batched logo lookup over the deduped, mapped id set (#482) — no per-token
  // call. A failure NEVER aborts the sync: it degrades to an empty map, so every
  // token simply falls back to a glyph (logos are decoration, prices are not).
  let logosById: Record<string, string | null> = {};
  if (distinctIds.length > 0 && deps.logoUrls) {
    try {
      logosById = await deps.logoUrls(distinctIds);
    } catch {
      logosById = {};
    }
  }

  // Resolve each CoinGecko id's price once, memoizing the in-flight promise so a
  // token held across several wallets shares the single lookup (rate-cap hygiene).
  const priceById = new Map<string, Promise<number | null>>();
  const resolvePrice = (coingeckoId: string): Promise<number | null> => {
    if (coingeckoId === "__fiat_eur__") return Promise.resolve(1);
    let pending = priceById.get(coingeckoId);
    if (!pending) {
      pending = deps.priceEur(coingeckoId);
      priceById.set(coingeckoId, pending);
    }
    return pending;
  };

  const drafts: TokenPositionDraft[] = [];
  for (let i = 0; i < balances.length; i++) {
    const line = balances[i]!;
    const coingeckoId = idByLine[i] ?? null;
    const price =
      coingeckoId === null
        ? null
        : coingeckoId === "__fiat_eur__"
          ? 1
          : await resolvePrice(coingeckoId);

    drafts.push({
      kind: "token",
      externalId: `${line.asset}:${line.wallet}`,
      name: line.asset,
      symbol: line.asset,
      balance: line.balance,
      wallet: line.wallet,
      // The wallet's rung: spot/funding/flexible-earn → market; locked-earn/
      // staking → term-locked (ADR 0016/0021, S3 #248). One source spans rungs.
      liquidityTier: rungForWallet(line.wallet),
      unitPrice: price === null ? null : String(price),
      imageUrl:
        coingeckoId === null || coingeckoId === "__fiat_eur__"
          ? null
          : (logosById[coingeckoId] ?? null),
      currency: "EUR",
    });
  }

  return drafts;
}

/**
 * The live EUR price for a CoinGecko id, or null on any miss/outage — the real
 * `priceEur` the web action wires into the sync (parallel to `fetchMetalSpotEur`).
 * Routes through the pricing seam (ADR 0026): `fetchPriceNow("coingecko", ctx)`
 * applies whatever fallback chain is declared for `coingecko`, so a Binance token
 * price now rides any future rescue the chain gains — the same fetch door the
 * manual `crypto` path will use, keeping a Binance BTC and a hand-entered BTC on
 * the same unit price (ADR 0021). CoinGecko quotes EUR (`vs_currencies=eur`), so
 * the returned price is already in EUR. Never throws: `fetchPriceNow` degrades a
 * miss to `null`, leaving the token unpriceable (value 0 + warning) rather than
 * aborting the whole sync.
 */
export async function fetchCoinGeckoPriceEur(
  coingeckoId: string,
  nowIso: string,
): Promise<number | null> {
  const fetched = await fetchPriceNow("coingecko", {
    assetId: "binance-token",
    symbol: coingeckoId,
    currency: "EUR",
    nowIso,
  });
  if (!fetched) return null;
  const value = Number(fetched.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The real batched logo seam the web action wires into the sync (#482): resolve the
 * logo URL for a set of CoinGecko ids in ONE `/coins/markets` call (which returns
 * price + image together, so logos ride alongside the existing per-id price burst
 * without a call per token). Keyed by id; an id absent from the response, or with no
 * image, maps to null → glyph fallback. Never throws: any miss/outage degrades to an
 * empty map so a logo failure never aborts the sync (parallel to fetchCoinGeckoPriceEur).
 */
export async function fetchCoinGeckoLogos(
  coingeckoIds: readonly string[],
): Promise<Record<string, string | null>> {
  if (coingeckoIds.length === 0) return {};
  try {
    // Raw commas in `ids` (the documented form; CoinGecko ids are lowercase
    // alphanumerics + hyphens, so none need escaping). `per_page` is capped at the
    // endpoint's max of 250 — a real account never holds that many distinct tokens.
    const perPage = Math.min(coingeckoIds.length, 250);
    const url =
      `${coingeckoBaseUrl()}/coins/markets?vs_currency=eur&ids=` +
      `${coingeckoIds.join(",")}&per_page=${perPage}&page=1`;
    const res = await fetch(url, {
      headers: coingeckoHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { id?: unknown; image?: unknown }[];
    const logos: Record<string, string | null> = {};
    for (const coin of data) {
      if (typeof coin?.id === "string") {
        logos[coin.id] =
          typeof coin.image === "string" && coin.image.length > 0 ? coin.image : null;
      }
    }
    return logos;
  } catch {
    return {};
  }
}
