/**
 * The generic connected-source adapter seam (ADR 0027, #319).
 *
 * worthline mirrors external accounts read-only (Numista, ADR 0016/0017; Binance,
 * ADR 0021). Each used to re-implement the same connect / sync / disconnect
 * lifecycle, selecting behaviour by re-branching on the persisted `SourceAdapter`
 * tag (`instrumentForAdapter`, `frozenInstrumentForAdapter`, the action guards).
 *
 * A `ConnectedSourceAdapter` closes that set of branches into ONE object the
 * generic lifecycle dispatches to: it owns the provider's instrument/rung
 * metadata, its credential parsing, and its network (listing / valuing / history).
 * The store and the actions look the adapter up once (via the registry) and call
 * it — no `adapter === "numista"` switch anywhere.
 *
 * The adapter lives in `@worthline/pricing` because its center of gravity is the
 * network + valuation (already concentrated here) and both `@worthline/db` and
 * `apps/web` already depend on pricing — so the registry is reachable from the
 * store and the actions without a new dependency cycle (ADR 0027 §Decision).
 */

import type {
  BinanceHistoryCurve,
  DistributiveOmit,
  Instrument,
  LiquidityTier,
  SourceAdapter,
  SourcePosition,
} from "@worthline/domain";

import type { MetalKind } from "../metal";
import type { NumistaCollectedItem, NumistaPrices, NumistaTypeDetail } from "../numista";

/** A position draft the store will persist (it assigns id + sourceId). Mirrors
 *  the db `SourcePositionInput` shape from domain primitives so the adapter stays
 *  in pricing (which depends only on domain). */
export type PositionDraft = DistributiveOmit<SourcePosition, "id" | "sourceId">;

/** A position's candidate values after a revalue pass (structurally compatible
 *  with the store's `PositionValuationUpdate` and pricing's `RevaluedPosition`). */
export interface PositionValuationUpdate {
  id: string;
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

/** A provider's monthly value history for backfill (Binance only today). */
export type SourceHistory = BinanceHistoryCurve;

/**
 * The injected network reads + clock the sync needs, mirroring the existing
 * `NumistaSyncDeps`/`BinanceSyncDeps` so the adapter stays pure-with-injected-IO
 * and unit-testable. The web layer wires the real readers; tests wire fakes.
 *
 * Numista's readers are OAuth-gated (the `token`); Binance signs per request. Both
 * shapes are carried optionally so one context type serves every provider — the
 * adapter reads only the readers it needs.
 */
export interface SyncContext<Creds, Token = null> {
  /** The parsed credentials (the API key, or key + secret). */
  creds: Creds;
  /** The cached auth token (Numista's OAuth token; `null` for Binance). */
  token: Token | null;
  /** Persist a freshly-minted token so the next sync reuses it (Numista). */
  saveToken: (token: Token) => void;
  /** The sync clock as an ISO string (the same `nowIso` the orchestrators take). */
  nowIso: string;
  /** The sync clock in epoch millis (token validity + Binance request windows). */
  nowMs: number;
  // ── Numista readers (OAuth-gated; the coin collection) ──
  listItems?: () => Promise<NumistaCollectedItem[]>;
  typeDetail?: (typeId: number) => Promise<NumistaTypeDetail>;
  prices?: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  spotPerOzEur?: (metal: MetalKind) => Promise<number | null>;
  // ── Binance readers (signed; the wallet balances) ──
  listBalances?: () => Promise<{ asset: string; wallet: string; balance: string }[]>;
  priceEur?: (coingeckoId: string) => Promise<number | null>;
}

/**
 * The injected reads the decoupled revalue needs (the stale-price pass): the
 * existing positions to re-derive plus the same readers the sync uses. Mirrors
 * `RevalueDeps`; Numista is the only provider with an in-place revalue (#323).
 */
export interface RevalueContext<Creds, Token = null> {
  creds: Creds;
  token: Token | null;
  saveToken: (token: Token) => void;
  nowIso: string;
  nowMs: number;
  /** The stored positions to revalue in place (never adding/removing lines). */
  positions: RevaluePositionInput[];
  prices?: (typeId: number, issueId: number) => Promise<NumistaPrices | null>;
  spotPerOzEur?: (metal: MetalKind) => Promise<number | null>;
}

/** A stored position carrying the detail needed to revalue it without re-listing
 *  (mirror of pricing's `RevaluePosition`). */
export interface RevaluePositionInput {
  id: string;
  typeId: number;
  issueId: number | null;
  grade: string;
  quantity: number;
  metal: MetalKind | null;
  finenessMillis: number | null;
  weightGrams: number | null;
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

/** The injected reads history reconstruction needs (Binance only). Mirrors
 *  `ReconstructBinanceHistoryDeps`. */
export interface HistoryContext<Creds, Token = null> {
  creds: Creds;
  token: Token | null;
  nowIso: string;
  nowMs: number;
  accountSnapshots?: () => Promise<unknown[]>;
  historicalPriceEur?: (
    coingeckoId: string,
    from: string,
    to: string,
  ) => Promise<Record<string, number> | null>;
}

/**
 * One provider's behaviour behind the generic connected-source lifecycle (ADR
 * 0027). `Creds` is the parsed credential shape; `Token` is the cached auth token
 * (Numista's OAuth token; `null` for Binance, which signs per-request).
 */
export interface ConnectedSourceAdapter<Creds, Token = null> {
  /** The persisted discriminator + the instrument/rung this provider projects
   *  into. Replaces the `instrumentForAdapter`/`frozenInstrumentForAdapter`/
   *  `rerollSourceHoldings` switches — the store reads these off the adapter. */
  readonly tag: SourceAdapter;
  readonly liveInstrument: Instrument; // coin_collection | crypto
  readonly frozenInstrument: Instrument; // precious_metal  | other
  /** The rung label for a term-locked holding, e.g. "(bloqueado)"; null for a
   *  single-rung source. Moves the hardcoded label out of the generic store. */
  readonly termLockedSuffix: string | null;

  // ── Credential parsing (replaces normalize*/build*/read* helpers) ──
  parseConnectForm(form: FormData): Creds | null;
  serializeCredentials(creds: Creds): string; // → credentialsJson
  readCredentials(credentialsJson: string): Creds | null;

  // ── Position listing + valuation (the sync; one network round-trip) ──
  /** List + value the source's positions into drafts. */
  listPositions(ctx: SyncContext<Creds, Token>): Promise<PositionDraft[]>;

  // ── Rung classification (moves Binance's wallet→rung INTO the adapter, #322) ──
  /** The rung a freshly-listed position projects onto. Numista returns
   *  "illiquid" for every coin; Binance maps wallet → market | term-locked. */
  classifyRung(position: PositionDraft): LiquidityTier;

  // ── Decoupled revalue (the stale-price pass; #323 folds this into sync) ──
  /** Re-derive what existing positions are worth WITHOUT re-listing. `null` ⇒
   *  the provider has no in-place revalue (Binance) and the caller re-syncs. */
  revalue:
    | ((ctx: RevalueContext<Creds, Token>) => Promise<PositionValuationUpdate[]>)
    | null;

  // ── History building (optional; Binance only) ──
  /** Build the provider's monthly value history for backfill; `null` for a
   *  provider whose history is generated store-side (Numista). */
  buildHistory: ((ctx: HistoryContext<Creds, Token>) => Promise<SourceHistory>) | null;
}
