/**
 * The Numista connected-source adapter (ADR 0027, #319).
 *
 * Numista mirrors a frozen, illiquid coin collection (ADR 0016/0017): a
 * `coin_collection` holding whose value is `max(metal, numismatic)` per coin,
 * frozen at sync; a disconnect-freeze flips it to a hand-valued `precious_metal`
 * holding. The collection is single-rung (every coin is `illiquid`), so there is
 * no term-locked label.
 *
 * The adapter owns ONLY Numista-specific parsing + the API surface. Its
 * `listPositions`/`revalue` DELEGATE to the existing `numista-sync.ts` /
 * `numista-revalue.ts` orchestrators — #323 folds those two files into this
 * adapter. `buildHistory` is null: Numista's purchase-date accretion is generated
 * store-side from the synced coins (`coinCollectionValueAtDate`), not by the API.
 */

import type { NumistaCredentials, NumistaToken } from "../numista";
import { refreshCoinValuations } from "../numista-revalue";
import { syncNumistaCollection } from "../numista-sync";
import type {
  ConnectedSourceAdapter,
  PositionDraft,
  PositionValuationUpdate,
} from "./types";

/** Numista credentials: the pasted API key (a SECRET, ADR 0016). */
export type NumistaCreds = NumistaCredentials;

/** Normalize a pasted API key, returning null when it is blank. */
function normalizeApiKey(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export const numistaAdapter: ConnectedSourceAdapter<NumistaCreds, NumistaToken> = {
  tag: "numista",
  liveInstrument: "coin_collection",
  frozenInstrument: "precious_metal",
  termLockedSuffix: null,

  parseConnectForm(form) {
    const apiKey = normalizeApiKey(form.get("apiKey"));
    return apiKey ? { apiKey } : null;
  },

  serializeCredentials(creds) {
    return JSON.stringify({ apiKey: creds.apiKey });
  },

  readCredentials(credentialsJson) {
    try {
      const parsed = JSON.parse(credentialsJson) as { apiKey?: unknown };
      return typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== ""
        ? { apiKey: parsed.apiKey }
        : null;
    } catch {
      return null;
    }
  },

  async listPositions(ctx): Promise<PositionDraft[]> {
    // The token-bound readers are wired into the context by the lifecycle (which
    // mints/refreshes the token + persists it via saveToken). #323 folds the mint
    // into this method directly.
    if (!ctx.listItems || !ctx.typeDetail || !ctx.prices || !ctx.spotPerOzEur) {
      throw new Error("Numista listPositions requires the collection readers.");
    }
    return syncNumistaCollection(
      {
        listItems: ctx.listItems,
        typeDetail: ctx.typeDetail,
        prices: ctx.prices,
        spotPerOzEur: ctx.spotPerOzEur,
      },
      ctx.nowIso,
    );
  },

  classifyRung() {
    // Every Numista coin is illiquid — the collection is single-rung.
    return "illiquid";
  },

  async revalue(ctx): Promise<PositionValuationUpdate[]> {
    if (!ctx.prices || !ctx.spotPerOzEur) {
      throw new Error("Numista revalue requires the price + spot readers.");
    }
    return refreshCoinValuations(
      ctx.positions,
      { prices: ctx.prices, spotPerOzEur: ctx.spotPerOzEur },
      { nowIso: ctx.nowIso },
    );
  },

  buildHistory: null,
};
