/**
 * The Binance connected-source adapter (ADR 0021/0027, #322).
 *
 * Binance mirrors a LIVE-valued crypto account (ADR 0021): one `crypto` holding per
 * occupied liquidity rung — spot/funding/flexible-Earn on the MARKET rung, locked
 * Earn on the TERM-LOCKED rung — each worth `Σ balance × live price`. A
 * disconnect-freeze flips every rung holding to a hand-valued `other` one.
 *
 * The adapter owns ONLY Binance-specific parsing + the API surface + the wallet→rung
 * map (relocated here out of `@worthline/domain`, #322). Its `listPositions` /
 * `buildHistory` DELEGATE to the existing `binance-sync.ts` / `binance-history.ts`
 * orchestrators (each injects its network reads from the context). `revalue` is null:
 * Binance has no in-place revalue — its revalue is a full re-list, so the lifecycle
 * re-syncs (the daily stale-price pass, `binance-refresh.ts`).
 *
 * The API key + secret are SECRETS (ADR 0021): serialized into credentialsJson for
 * the local DB only — never logged, never placed in a redirect URL.
 */

import type { BinanceCredentials } from "@pricing/binance";
import { reconstructBinanceHistory } from "@pricing/binance-history";
import { syncBinanceAccount } from "@pricing/binance-sync";
import { rungForWallet } from "./binance-rung";
import type { ConnectedSourceAdapter, PositionDraft, SourceHistory } from "./types";

export { rungForWallet } from "./binance-rung";

/** Binance credentials: the API key + secret (both SECRETS, the secret signs). */
export type BinanceCreds = BinanceCredentials;

/**
 * Normalize a pasted key + secret, returning null when either is blank. Both are
 * trimmed; a Binance source needs both (the key for the header, the secret for
 * signing), so a missing half is a no-go.
 */
function normalizeCreds(apiKey: unknown, apiSecret: unknown): BinanceCreds | null {
  const key = String(apiKey ?? "").trim();
  const secret = String(apiSecret ?? "").trim();
  if (key === "" || secret === "") {
    return null;
  }
  return { apiKey: key, apiSecret: secret };
}

export const binanceAdapter: ConnectedSourceAdapter<BinanceCreds, null> = {
  tag: "binance",
  liveInstrument: "crypto",
  frozenInstrument: "other",
  termLockedSuffix: "(bloqueado)",

  // ── Credential parsing (folded in from binance-helpers.ts, #322). ──
  parseConnectForm(form) {
    return normalizeCreds(form.get("apiKey"), form.get("apiSecret"));
  },

  serializeCredentials(creds) {
    return JSON.stringify({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
  },

  readCredentials(credentialsJson) {
    try {
      const parsed = JSON.parse(credentialsJson) as {
        apiKey?: unknown;
        apiSecret?: unknown;
      };
      return normalizeCreds(parsed.apiKey, parsed.apiSecret);
    } catch {
      return null;
    }
  },

  // ── Position listing: list ALL wallet balances + price each live (#322). ──
  // The signed balance reader + the CoinGecko price reader are wired into the
  // context by the lifecycle; the rung is stamped per draft by `syncBinanceAccount`
  // via the relocated `rungForWallet` (so one source spans rungs, ADR 0016/0021).
  async listPositions(ctx): Promise<PositionDraft[]> {
    if (!ctx.listBalances || !ctx.priceEur) {
      throw new Error("Binance listPositions requires the balance + price readers.");
    }
    return syncBinanceAccount({
      listBalances: ctx.listBalances,
      priceEur: ctx.priceEur,
      // Only thread the logo reader when wired (exactOptionalPropertyTypes: never
      // pass an explicit `undefined` to the optional dep).
      ...(ctx.logoUrls ? { logoUrls: ctx.logoUrls } : {}),
    });
  },

  // The wallet→rung map relocated out of @worthline/domain (#322): a token's rung
  // is its wallet's rung (spot/funding/flexible-earn → market; locked-earn/staking
  // → term-locked). A coin (non-Binance) never reaches here, but for totality it
  // defaults to market.
  classifyRung(position) {
    return position.kind === "token" ? rungForWallet(position.wallet) : "market";
  },

  // Binance has no in-place revalue — its revalue is a full re-list (the lifecycle
  // re-syncs). See `binance-refresh.ts` (the daily stale-price re-sync).
  revalue: null,

  // ── Monthly history: reconstruct the API-bounded curve (#322). ──
  // Delegates to `reconstructBinanceHistory`; the signed snapshot reader + the
  // CoinGecko range reader are wired into the context by the lifecycle's afterWrite.
  async buildHistory(ctx): Promise<SourceHistory> {
    if (!ctx.accountSnapshots || !ctx.historicalPriceEur) {
      throw new Error("Binance buildHistory requires the snapshot + history readers.");
    }
    return reconstructBinanceHistory({
      accountSnapshots: ctx.accountSnapshots,
      historicalPriceEur: ctx.historicalPriceEur,
    });
  },
};
