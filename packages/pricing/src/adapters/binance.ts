/**
 * The Binance connected-source adapter — MINIMAL SHIM for #319 (ADR 0027).
 *
 * #319 migrates ONLY Numista behind the generic lifecycle. This shim exists so the
 * provider-agnostic store (`connected-source-store.ts`) can resolve a Binance row's
 * instrument/term-locked-suffix metadata off an adapter (instead of the old
 * `instrumentForAdapter`/`frozenInstrumentForAdapter` switch + the hardcoded
 * "(bloqueado)" label) WITHOUT changing any Binance behaviour. It carries exactly
 * today's facts:
 *   - liveInstrument `crypto` / frozenInstrument `other`  (instrumentForAdapter)
 *   - termLockedSuffix "(bloqueado)"                      (the store's old literal)
 *   - classifyRung = rungForWallet                        (today's wallet→rung map)
 *
 * #322 OWNS THE REST: moving Binance connect/sync/disconnect onto the generic
 * lifecycle, folding the real credential parsing + `listPositions`/`buildHistory`
 * (syncBinanceAccount / reconstructBinanceHistory) into this adapter, and relocating
 * `rungForWallet` out of `@worthline/domain`. Until then the Binance ACTION path is
 * untouched and these IO methods are intentionally unused (the store reads only the
 * metadata above + classifyRung); calling them throws to flag the #322 gap.
 */

import type { BinanceCredentials } from "../binance";
import { rungForWallet } from "@worthline/domain";

import type { ConnectedSourceAdapter } from "./types";

/** Binance credentials: the API key + secret (both SECRETS, the secret signs). */
export type BinanceCreds = BinanceCredentials;

export const binanceAdapter: ConnectedSourceAdapter<BinanceCreds, null> = {
  tag: "binance",
  liveInstrument: "crypto",
  frozenInstrument: "other",
  termLockedSuffix: "(bloqueado)",

  // ── #322: credential parsing folds in from binance-helpers.ts. ──
  parseConnectForm() {
    throw new Error("Binance adapter: connect lifecycle is #322; use binance-actions.");
  },
  serializeCredentials() {
    throw new Error("Binance adapter: connect lifecycle is #322; use binance-actions.");
  },
  readCredentials() {
    throw new Error("Binance adapter: sync lifecycle is #322; use binance-actions.");
  },

  // ── #322: listPositions folds in syncBinanceAccount. ──
  async listPositions() {
    throw new Error("Binance adapter: sync lifecycle is #322; use binance-actions.");
  },

  // The ONE Binance fact the store needs today: the relocated wallet→rung map.
  // #322 moves `rungForWallet` out of @worthline/domain into here.
  classifyRung(position) {
    return position.kind === "token" ? rungForWallet(position.wallet) : "market";
  },

  // Binance has no in-place revalue — its revalue is a full re-list (the lifecycle
  // re-syncs). Preserved for #322.
  revalue: null,

  // ── #322: buildHistory folds in reconstructBinanceHistory. ──
  buildHistory: null,
};
