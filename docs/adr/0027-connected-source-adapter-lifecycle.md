# A connected source is one generic lifecycle behind a per-provider adapter

> **Superseded by [ADR 0043](0043-connected-source-lifecycle-stays-explicit-per-provider.md)** (2026-06-26, #577). At two providers with divergent lifecycles the adapter interface + registry + nullable capabilities cost more indirection than they remove; connected-source behaviour goes back to explicit per-provider modules. Kept here for history.

## Context

worthline has two connected sources — Numista (ADR 0016/0017) and Binance (ADR 0021) — and each re-implements the same connect / sync / disconnect lifecycle. The duplication is concrete:

- **Action layer** `apps/web/app/ajustes/numista-actions.ts` and `binance-actions.ts` are near-identical glue: the same `currentUrlOf`/`runWith`/`scopeMemberId` triplet (numista-actions.ts:49-61 ≡ binance-actions.ts:49-61), the same connect shape (read workspace → reject second source → `resolveConnectingOwnership` → `store.connectedSources.connect`), the same sync shape (read creds inside the store → `await` network outside it → write inside it → redirect), and the same disconnect freeze/remove fork.
- **Helpers** `numista-helpers.ts` and `binance-helpers.ts` already share `resolveConnectingOwnership` and `formatLastSync` by re-export (binance-helpers.ts:17), but each hand-rolls its own `normalize* / buildCredentialsJson / read*` credential parsing.
- **Pricing** carries four orchestrators (`numista-sync.ts`, `numista-revalue.ts`, `binance-sync.ts`, `binance-history.ts`) that all follow the same "inject the network reads, dedupe per key, return drafts" pattern. #323 notes `numista-sync.ts` and `numista-revalue.ts` duplicate Numista response parsing and position-row construction.
- **Provider leaks in the generic store** `connected-source-store.ts` is meant to be provider-agnostic, but `rerollSourceHoldings` reaches for `instrumentForAdapter(source.adapter)` (line 343) and hardcodes the term-locked label `${source.label} (bloqueado)` (line 374-383); `freeze` reaches for `frozenInstrumentForAdapter` (line 639). The wallet→rung map `rungForWallet` lives in `packages/domain/src/connected-source.ts:63` and is called from `binance-sync.ts:66` — a Binance fact sitting in shared code (#322 wants it inside the Binance adapter).

The existing `SourceAdapter` type (connected-source.ts:27) is **just a string union** `"numista" | "binance"`, used as a discriminator that downstream code `switch`es on (`instrumentForAdapter`, `frozenInstrumentForAdapter`, the action-level `existing.adapter === ...` guards). That is the root of every leak: behaviour is selected by _re-branching on a tag_ in many places instead of _dispatching to one object_ that owns the provider's behaviour.

This decision must preserve the read-only-mirror contract (ADR 0016: positions are sub-detail; the holding's value is derived, never hand-set; ownership is the one mutable field; disconnect offers remove-or-freeze) and the Binance projection rules (ADR 0021: live `balance × price`, per-rung holdings, monthly API-bounded frozen history).

## Decision

Introduce a **`ConnectedSourceAdapter`** interface that captures the per-provider behaviour the lifecycle needs, and a single generic lifecycle that calls it. `SourceAdapter` keeps its current meaning — the **persisted tag** (`"numista" | "binance"`), the discriminator stored in `connected_sources.adapter` — and gains a sibling: a **registry** mapping each tag to one adapter object. Code stops re-branching on the tag; it looks the adapter up once and dispatches.

The adapter lives in **`packages/pricing`** (`packages/pricing/src/adapters/`). It owns the network and the provider's valuation/classification logic — both already concentrated there — and depends on `@worthline/domain` for the position/rung vocabulary. `packages/db` and `apps/web` depend on `@worthline/pricing`, so the registry is reachable from both the store and the actions without a new dependency edge or a cycle.

```ts
// packages/pricing/src/adapters/types.ts
import type {
  Instrument,
  LiquidityTier,
  SourceAdapter,
  SourcePosition,
  SourcePositionInput,
} from "@worthline/domain";

/** A position draft the store will persist (it assigns id + sourceId). */
type PositionDraft = SourcePositionInput;

/** One provider's behaviour behind the generic connected-source lifecycle (#312).
 *  `Creds` is the parsed credential shape; `Token` is the cached auth token
 *  (Numista's OAuth token; `null` for Binance, which signs per-request). */
export interface ConnectedSourceAdapter<Creds, Token = null> {
  /** The persisted discriminator + the instrument/rung this provider projects
   *  into. Replaces the `instrumentForAdapter`/`frozenInstrumentForAdapter`/
   *  `rerollSourceHoldings` switches — the store reads these off the adapter. */
  readonly tag: SourceAdapter;
  readonly liveInstrument: Instrument; // coin_collection | crypto
  readonly frozenInstrument: Instrument; // precious_metal  | other
  /** The rung label for a term-locked holding, e.g. "(bloqueado)"; null for a
   *  single-rung source. Moves the hardcoded label out of the generic store. */
  termLockedSuffix: string | null;

  // ── Credential parsing (replaces normalize*/build*/read* helpers) ──
  parseConnectForm(form: FormData): Creds | null;
  serializeCredentials(creds: Creds): string; // → credentialsJson
  readCredentials(credentialsJson: string): Creds | null;

  // ── Position listing + valuation (the sync; one network round-trip) ──
  /** List + value the source's positions into drafts. Numista mints/reuses the
   *  OAuth token (via `token`), pulls the collection, resolves max(metal,
   *  numismatic); Binance signs per request, lists balances, prices each live. */
  listPositions(ctx: SyncContext<Creds, Token>): Promise<PositionDraft[]>;

  // ── Rung classification (moves Binance's wallet→rung INTO the adapter, #322) ──
  /** The rung a freshly-listed position projects onto. Numista returns
   *  "illiquid" for every coin; Binance maps wallet → market | term-locked. */
  classifyRung(position: PositionDraft): LiquidityTier;

  // ── Decoupled revalue (the stale-price pass; #323 folds this into sync) ──
  /** Re-derive what existing positions are worth WITHOUT re-listing. Numista
   *  recomputes melt + refetches numismatic past its TTL (budget-respecting);
   *  Binance re-lists+re-prices live (its revalue IS a re-sync). Returns the
   *  per-position value updates the store applies. `null` ⇒ provider has no
   *  in-place revalue (Binance) and the caller re-syncs instead. */
  revalue:
    | ((ctx: RevalueContext<Creds, Token>) => Promise<PositionValuationUpdate[]>)
    | null;

  // ── History building (optional; Binance only) ──
  /** Build the provider's monthly value history for backfill. Numista has none
   *  (purchase-date accretion is generated store-side from the synced coins);
   *  Binance reconstructs the API-bounded monthly curve. */
  buildHistory: ((ctx: HistoryContext<Creds, Token>) => Promise<SourceHistory>) | null;
}
```

`SyncContext`/`RevalueContext`/`HistoryContext` carry the **injected network reads + clock** (exactly the `*Deps` interfaces today: `NumistaSyncDeps`, `BinanceSyncDeps`, `RevalueDeps`, `ReconstructBinanceHistoryDeps`) plus the parsed `creds`, the cached `token`, and a `saveToken` callback — so the adapter stays pure-with-injected-IO and unit-testable, unchanged from today. The web layer wires the real `getCollectedItems`/`getAllBalances`/CoinGecko/Stooq readers into the context; tests wire fakes.

**The generic lifecycle** is a thin function module that the actions delegate to (`apps/web/app/ajustes/connected-source-lifecycle.ts`), parameterized by `adapter`:

```ts
connectSource(adapter, form, store); // parse form → reject 2nd → resolve ownership → store.connectedSources.connect
syncSource(adapter, sourceId, store); // read creds → adapter.listPositions(ctx) → store.syncConnectedSource → adapter.buildHistory?
disconnectSource(adapter, sourceId, mode); // freeze → freezeIntoStoredHolding ; remove → removeSourceHoldings
```

It keeps the **read-creds-sync / await-network / write-sync** ordering the `withStore` sync constraint demands (the comment at numista-actions.ts:41-44 and binance-actions.ts:41-44), the `_store?` test seam (`runWith`), and the redirect/error vocabulary. Each provider's `*-actions.ts` shrinks to four one-liners that pass its registry adapter into these functions.

**The store becomes provider-agnostic.** `rerollSourceHoldings` and `freezeIntoStoredHolding` stop importing `instrumentForAdapter`/`frozenInstrumentForAdapter` and stop hardcoding `(bloqueado)`; instead the store resolves the adapter from the row's `tag` once (`registry[row.adapter]`) and reads `liveInstrument` / `frozenInstrument` / `termLockedSuffix` off it. The rung is already stamped onto each position by `classifyRung` at sync time (connected-source.ts:63 `rungForWallet` moves into the Binance adapter, satisfying #322), so the store's `projectConnectedSource` keeps grouping by the per-position `liquidityTier` it already reads (connected-source.ts:327) — no provider branch needed.

**Numista fits** as `ConnectedSourceAdapter<{apiKey}, NumistaToken>`: `liveInstrument="coin_collection"`, `frozenInstrument="precious_metal"`, `termLockedSuffix=null`, `classifyRung` returns `"illiquid"`, `revalue` does the budget/TTL-gated melt+numismatic refresh (#323 merges `numista-sync.ts`+`numista-revalue.ts` into this one adapter with `listPositions`+`revalue` modes), `buildHistory=null` (purchase-date accretion stays the store/domain's `coinCollectionValueAtDate`).

**Binance fits** as `ConnectedSourceAdapter<{apiKey,apiSecret}, null>`: `liveInstrument="crypto"`, `frozenInstrument="other"`, `termLockedSuffix="(bloqueado)"`, `classifyRung` maps wallet→rung (the relocated `rungForWallet`), `revalue=null` (its revalue is a full re-list → the lifecycle re-syncs), `buildHistory` returns the monthly curve that `applyBinanceHistoryAndRipple` freezes.

## Considered options

- **Adapter object in `packages/pricing`, registry by tag (chosen).** The network + valuation already live here; both `db` and `web` already depend on it. One place to add the third source. Cost: the store gains a `@worthline/pricing` import (today it has none — it depends only on `@worthline/domain`). Mitigated by importing only the tiny registry/metadata, not the network code; if the dependency edge is unwanted, the four metadata fields (`liveInstrument`/`frozenInstrument`/`termLockedSuffix` + `classifyRung`'s output) can stay in `@worthline/domain` (where `instrumentForAdapter` already is) and only the IO methods live in pricing. **(This db→pricing edge is the one open call flagged for human review.)**
- **Adapter in `packages/db`.** Rejected: `db` must not import the network layer, and the adapter's center of gravity (listing/valuing/history) is network IO. Would invert the dependency and drag fetch code into persistence.
- **Adapter in `apps/web`.** Rejected: the store needs the instrument/rung metadata to stay provider-agnostic, and `db` cannot depend on `apps/web`. The pricing orchestrators would also have to move up, abandoning their package.
- **Keep `SourceAdapter` as the only abstraction, push behaviour into bigger domain switch functions.** Rejected: this is the status quo's root cause — every new provider re-branches `instrumentForAdapter`, `frozenInstrumentForAdapter`, `rungForWallet`, and the action guards. An object closes the set of branches into one lookup.
- **One uber-method `runLifecycle(phase, …)` instead of discrete methods.** Rejected for the same reason ADR 0020 chose typed methods over a polymorphic fact: discrete, precisely-typed methods (`listPositions`, `revalue`, `buildHistory`) document each provider's real surface (Binance has no `revalue`, Numista has no `buildHistory`) far better than a stringly-typed phase switch.

## Consequences

- **`packages/pricing/src/adapters/` is the new home** for `numista.ts` and `binance.ts` adapter objects implementing `ConnectedSourceAdapter`, plus `registry.ts` mapping `SourceAdapter` → adapter. #323's merge of `numista-sync.ts`+`numista-revalue.ts` lands as the Numista adapter's `listPositions`+`revalue`.
- **`apps/web/app/ajustes/*-actions.ts` collapse** to thin per-provider wrappers over the generic `connect/sync/disconnect` lifecycle functions; `*-refresh.ts` (the stale-price pass) call `adapter.revalue ?? re-sync` through the same registry. `currentUrlOf`/`runWith`/`scopeMemberId` move into the shared lifecycle module.
- **`connected-source-store.ts` loses its provider imports.** `rerollSourceHoldings`/`freezeIntoStoredHolding` resolve instrument/suffix off the adapter; `rungForWallet` leaves `@worthline/domain` for the Binance adapter (#322). The store keeps grouping by the already-stamped per-position `liquidityTier`, so per-rung projection is unaffected.
- **ADR 0016 is preserved**: positions stay sub-detail, the holding's value stays derived (the adapter only returns drafts/updates; the store still re-rolls), ownership stays the one mutable field, and disconnect keeps the remove/freeze fork — none of this moves into the adapter.
- **ADR 0021 is preserved**: live `balance × price`, per-rung holdings, and the monthly API-bounded frozen history are exactly the Binance adapter's `listPositions`/`classifyRung`/`buildHistory`; `revalue=null` keeps "Binance revalue is a re-sync".
- **A future AFK agent** implementing #319/#322/#323 has a closed contract: implement the interface, register the tag, delete the bespoke action/helper/orchestrator duplication. A third source (a broker, ADR 0018's territory) is a new adapter + one registry line, no lifecycle edits.
- **Trade-off**: a small indirection cost (a registry lookup and a context object per call) and one new `db → pricing` import edge, in exchange for removing four duplicated lifecycles and every `adapter ===` branch. The fallback (metadata in domain, IO in pricing) is available if that edge proves unwanted.
