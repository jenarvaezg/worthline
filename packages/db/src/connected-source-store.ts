import type {
  ConnectedSource,
  DistributiveOmit,
  OwnershipShare,
  PriceFreshnessState,
  SourceAdapter,
  SourcePosition,
} from "@worthline/domain";
import {
  defaultsFor,
  frozenInstrumentForAdapter,
  instrumentForAdapter,
  projectConnectedSource,
} from "@worthline/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
} from "./agent-view-public-ids";
import { openSecret, sealSecret } from "./crypto";
import {
  assetOwnerships,
  assetPriceCache,
  assets,
  connectedSources,
  positions,
} from "./schema";
import {
  hardDeleteAssetTx,
  readAssetOwnerships,
  type StoreContext,
} from "./store-context";

/** Connect a new source: the caller resolves ownership (default 100% the
 *  connecting member) before handing it here. */
export interface ConnectSourceInput {
  adapter: SourceAdapter;
  label: string;
  credentialsJson: string;
  ownership: OwnershipShare[];
}

/** A persisted connected-source row, secrets included (local only, ADR 0016). */
export interface ConnectedSourceRow {
  id: string;
  adapter: SourceAdapter;
  label: string;
  assetId: string;
  credentialsJson: string;
  tokenJson: string | null;
  lastSyncAt: string | null;
}

/** A position to persist — the store assigns id + sourceId. Distributes over the
 *  coin/token union so each variant keeps its discriminated fields. */
export type SourcePositionInput = DistributiveOmit<SourcePosition, "id" | "sourceId">;

/** A refreshed coin's candidate values, applied to an existing position by id
 *  (PRD #166). Structurally compatible with pricing's `RevaluedPosition`. */
export interface PositionValuationUpdate {
  id: string;
  metalValueMinor: number | null;
  numismaticValueMinor: number | null;
  numismaticFetchedAt: string | null;
}

/** The valuation freshness stamped on the coin-collection's price-cache row: the
 *  staleness indicator and the daily stale-price-pass trigger (ADR 0017). */
export interface ValuationFreshness {
  fetchedAt: string;
  freshnessState: PriceFreshnessState;
  staleReason?: string;
}

/**
 * Persistence for connected sources (PRD #160 / #163, ADR 0016/0017): an external
 * account worthline mirrors read-only, projecting its positions into one
 * rolled-up holding whose value is derived from the positions, never hand-set.
 */
export interface ConnectedSourceStore {
  connect(input: ConnectSourceInput): Promise<{ sourceId: string; assetId: string }>;
  saveToken(sourceId: string, tokenJson: string): Promise<void>;
  /**
   * Replace a source's stored credentials (sealed at rest). Used by the sync
   * engine (#388) to re-apply prod's secrets after a full-replace import wipes
   * them, so a hosted push never severs the live connection (ADR 0030/0016).
   */
  updateCredentials(sourceId: string, credentialsJson: string): Promise<void>;
  readSource(sourceId: string): Promise<ConnectedSourceRow | null>;
  listSources(): Promise<ConnectedSourceRow[]>;
  /**
   * Every asset id this source materialized — one per occupied rung (ADR 0016,
   * #248). The market (primary) asset is `connected_sources.asset_id`; the others
   * (e.g. term-locked) carry the source id only via `assets.connected_source_id`
   * (no back-FK), so disconnect must delete them explicitly. Ordered by rung.
   */
  listSourceAssetIds(sourceId: string): Promise<string[]>;
  /**
   * Remove ALL of a source's materialized holdings in ONE transaction (ADR 0016,
   * #248): for each rung asset (market + term-locked) soft-delete then hard-delete,
   * so deleting the market (primary) asset cascades the source row + its positions
   * away while the other-rung assets (no back-FK) are removed explicitly — all
   * committing or rolling back together (no partially-deleted source on a mid-loop
   * failure). Returns the number of asset rows removed (0 when nothing matched).
   */
  removeSourceHoldings(sourceId: string): Promise<{ removed: number }>;
  /**
   * The connected source id an asset materializes a rung of (ADR 0016, #248), or
   * null for a hand-maintained holding. Resolves the source from ANY of the
   * source's rung assets — the market (primary) one OR the term-locked one — so the
   * detail page can route both to the read-only surface (the term-locked asset's id
   * never matches `connected_sources.asset_id`).
   */
  readSourceIdForAsset(assetId: string): Promise<string | null>;
  readPositions(sourceId: string): Promise<SourcePosition[]>;
  /** Replace the source's positions, re-roll the holding's value, stamp last sync. */
  syncPositions(
    sourceId: string,
    positions: SourcePositionInput[],
    syncedAt: string,
  ): Promise<void>;
  /**
   * Apply refreshed candidate values to existing positions (by id), re-roll the
   * holding's value, and stamp the coin-collection's valuation-freshness row —
   * the decoupled valuation refresh (PRD #166, ADR 0017). Unlike `syncPositions`
   * this never adds/removes lines; it only updates what each coin is worth.
   */
  revaluePositions(
    sourceId: string,
    updates: PositionValuationUpdate[],
    freshness: ValuationFreshness,
  ): Promise<void>;
  /**
   * Freeze the source's projected holding(s) into plain hand-maintained holdings
   * (PRD #160 story 21 / #245 S6, ADR 0016): drop the source — cascading its
   * positions — and flip EVERY rung asset it materialized (one for Numista, market
   * + term-locked for Binance) from the derived/live source instrument to its
   * hand-valued counterpart (the adapter's `frozenInstrument`: coin_collection →
   * precious_metal, crypto → other). Each asset keeps its frozen value, name,
   * ownership and rung but is fully detached (its `connected_source_id` cleared) so
   * nothing routes it back to the gone source or re-values it; the effective
   * valuation method is read off the instrument, so flipping it is what makes the
   * holding hand-valued. Frozen snapshots are untouched and each orphaned
   * connected-source price-cache row is cleared. Returns the primary (market)
   * asset id, or null when the source is unknown (nothing changes then).
   */
  freezeIntoStoredHolding(sourceId: string): Promise<{ assetId: string } | null>;
}

/** The columns that make up a {@link ConnectedSourceRow}. */
const sourceColumns = {
  id: connectedSources.id,
  adapter: connectedSources.adapter,
  label: connectedSources.label,
  assetId: connectedSources.assetId,
  credentialsJson: connectedSources.credentialsJson,
  tokenJson: connectedSources.tokenJson,
  lastSyncAt: connectedSources.lastSyncAt,
} as const;

/**
 * Map a raw `positions` row to a domain {@link SourcePosition} — the single source
 * of truth for the column→field shape, shared by the store reader, the export
 * serializer, and the historical-snapshot deps builder (#167). Dispatches on the
 * `kind` discriminant (ADR 0021): a token row reads symbol/balance/wallet/price; a
 * coin row reads the catalogue/grade/metal/candidate columns. Numeric columns are
 * coerced; a row with no `external_id` (pre-v20) falls back to its (stable, unique)
 * internal id so the cross-sync diff key is never null.
 */
export function mapPositionRow(row: typeof positions.$inferSelect): SourcePosition {
  const core = {
    id: row.id,
    sourceId: row.sourceId,
    externalId: row.externalId ?? row.id,
    name: row.name,
    liquidityTier: row.liquidityTier,
    currency: row.currency,
  };

  if (row.kind === "token") {
    return {
      ...core,
      kind: "token",
      symbol: row.symbol ?? "",
      balance: row.balance ?? "0",
      wallet: row.wallet ?? "",
      unitPrice: row.unitPrice,
      imageUrl: row.imageUrl ?? null,
    };
  }

  return {
    ...core,
    kind: "coin",
    catalogueId: row.catalogueId ?? "",
    issueId: row.issueId === null ? null : Number(row.issueId),
    grade: row.grade ?? "",
    quantity: Number(row.quantity ?? 0),
    year: row.year === null ? null : Number(row.year),
    metal: row.metal,
    finenessMillis: row.finenessMillis === null ? null : Number(row.finenessMillis),
    weightGrams: row.weightGrams === null ? null : Number(row.weightGrams),
    purchaseDate: row.purchaseDate,
    metalValueMinor: row.metalValueMinor === null ? null : Number(row.metalValueMinor),
    numismaticValueMinor:
      row.numismaticValueMinor === null ? null : Number(row.numismaticValueMinor),
    numismaticFetchedAt: row.numismaticFetchedAt,
    purchasePriceMinor:
      row.purchasePriceMinor === null ? null : Number(row.purchasePriceMinor),
    obverseThumbUrl: row.obverseThumbUrl ?? null,
  };
}

/**
 * The full `positions` column set for one domain position — the single source of
 * truth for the field→column write shape, shared by `syncPositions` and the
 * import path (ADR 0021). Dispatches on `kind`: the OTHER kind's columns are
 * written null so every batched row carries a uniform column set (drizzle requires
 * it). The caller assigns `id`/`sourceId` on the position before handing it here.
 */
export function positionInsertValues(
  position: SourcePosition,
): typeof positions.$inferInsert {
  const core = {
    id: position.id,
    sourceId: position.sourceId,
    kind: position.kind,
    externalId: position.externalId,
    name: position.name,
    liquidityTier: position.liquidityTier,
    currency: position.currency,
  };

  if (position.kind === "token") {
    return {
      ...core,
      catalogueId: null,
      issueId: null,
      grade: null,
      quantity: null,
      year: null,
      metal: null,
      finenessMillis: null,
      weightGrams: null,
      purchaseDate: null,
      purchasePriceMinor: null,
      obverseThumbUrl: null,
      metalValueMinor: null,
      numismaticValueMinor: null,
      numismaticFetchedAt: null,
      symbol: position.symbol,
      balance: position.balance,
      wallet: position.wallet,
      unitPrice: position.unitPrice,
      imageUrl: position.imageUrl,
    };
  }

  return {
    ...core,
    catalogueId: position.catalogueId,
    issueId: position.issueId,
    grade: position.grade,
    quantity: position.quantity,
    year: position.year,
    metal: position.metal,
    finenessMillis: position.finenessMillis,
    weightGrams: position.weightGrams,
    purchaseDate: position.purchaseDate,
    purchasePriceMinor: position.purchasePriceMinor,
    obverseThumbUrl: position.obverseThumbUrl,
    metalValueMinor: position.metalValueMinor,
    numismaticValueMinor: position.numismaticValueMinor,
    numismaticFetchedAt: position.numismaticFetchedAt,
    symbol: null,
    balance: null,
    wallet: null,
    unitPrice: null,
    imageUrl: null,
  };
}

function termLockedSuffixForAdapter(adapter: SourceAdapter): string | null {
  return adapter === "binance" ? "(bloqueado)" : null;
}

export function createConnectedSourceStore(ctx: StoreContext): ConnectedSourceStore {
  const { db } = ctx;

  // Secrets live encrypted at rest (ADR 0030, #387): seal on write, open on
  // read, so the database holds only ciphertext while callers see plaintext.
  const openRow = (row: ConnectedSourceRow): ConnectedSourceRow => ({
    ...row,
    credentialsJson: openSecret(row.credentialsJson),
    tokenJson: row.tokenJson === null ? null : openSecret(row.tokenJson),
  });

  const readSource = async (sourceId: string): Promise<ConnectedSourceRow | null> => {
    const row = await db
      .select(sourceColumns)
      .from(connectedSources)
      .where(eq(connectedSources.id, sourceId))
      .get();
    return row ? openRow(row) : null;
  };

  const readPositionsForSource = async (sourceId: string): Promise<SourcePosition[]> => {
    const rows = await db
      .select()
      .from(positions)
      .where(eq(positions.sourceId, sourceId))
      .orderBy(asc(positions.createdAt), asc(positions.id))
      .all();
    return rows.map(mapPositionRow);
  };

  // Returns ALL of a source's materialized assets — INCLUDING soft-deleted
  // (trashed) ones — so disconnect (`removeSourceHoldings`) cleans up every rung
  // asset, even one a prior reroll left trashed. This differs deliberately from
  // `rerollSourceHoldings`' `existing` lookup, which filters `deletedAt IS NULL`
  // so reroll only reconciles LIVE rung assets (#248, FIX 6).
  const listSourceAssetIds = async (sourceId: string): Promise<string[]> => {
    const rows = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.connectedSourceId, sourceId))
      .orderBy(asc(assets.liquidityTier), asc(assets.createdAt), asc(assets.id))
      .all();
    return rows.map((row) => row.id);
  };

  const assetTierOf = async (assetId: string) =>
    (
      await db
        .select({ tier: assets.liquidityTier })
        .from(assets)
        .where(eq(assets.id, assetId))
        .get()
    )?.tier;

  const readSourceIdForAsset = async (assetId: string): Promise<string | null> =>
    (
      await db
        .select({ sourceId: assets.connectedSourceId })
        .from(assets)
        .where(eq(assets.id, assetId))
        .get()
    )?.sourceId ?? null;

  /**
   * Project ALL the source's positions and reconcile its materialized assets with
   * the result — one asset per occupied liquidity rung (ADR 0016, #248). For each
   * projected holding: find this source's asset on that rung
   * (`connected_source_id = source.id AND liquidity_tier = rung`); UPDATE its value
   * if it exists, else CREATE it (a derived holding of the adapter's instrument on
   * the rung, linked back to the source, inheriting the source's ownership). Any
   * existing source asset whose rung is NOT in the projection is set to value 0
   * (never deleted — frozen snapshots/identity must survive an emptied rung).
   *
   * The market (primary) asset (`connected_sources.asset_id`) is always among them
   * and is the one `revaluePositions` stamps its freshness row on. Returns the value
   * of that primary asset (parity with the prior single-asset reroll's return).
   */
  const rerollSourceHoldings = async (source: ConnectedSourceRow): Promise<number> => {
    const ownership = (await readAssetOwnerships(db)).get(source.assetId) ?? [];
    const domainSource: ConnectedSource = {
      adapter: source.adapter,
      id: source.id,
      label: source.label,
      ownership,
    };
    const holdings = projectConnectedSource(
      domainSource,
      await readPositionsForSource(source.id),
    );
    // ADR 0043: at two connected-source providers, an explicit tag branch is
    // cheaper than the old adapter registry.
    const instrument = instrumentForAdapter(source.adapter);
    const termLockedSuffix = termLockedSuffixForAdapter(source.adapter);
    const projectedTiers = new Set(holdings.map((holding) => holding.liquidityTier));

    let primaryValueMinor = 0;
    const now = sql`CURRENT_TIMESTAMP`;

    for (const holding of holdings) {
      // Reconcile only LIVE rung assets: a trashed (soft-deleted) rung asset must
      // NOT be updated or resurrected here — if the prior rung asset was trashed,
      // materialize a fresh live one instead. (listSourceAssetIds, by contrast,
      // returns ALL source assets including trashed ones, so disconnect still cleans
      // them up.)
      const existing = await db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.connectedSourceId, source.id),
            eq(assets.liquidityTier, holding.liquidityTier),
            isNull(assets.deletedAt),
          ),
        )
        .get();

      if (existing) {
        await db
          .update(assets)
          .set({ currentValueMinor: holding.valueMinor, updatedAt: now })
          .where(eq(assets.id, existing.id))
          .run();
      } else {
        // A newly-occupied rung (e.g. the first locked-Earn balance). Materialize a
        // derived holding for it, named per rung: the primary keeps the source
        // label, a term-locked one is tagged with the provider suffix (e.g.
        // "(bloqueado)") so the two are distinguishable in the patrimonio list. The
        // suffix is explicit per provider (ADR 0043), not hardcoded per caller.
        // valuation_method stays null — derived at runtime from the instrument.
        const assetId = ctx.newId();
        const name =
          holding.liquidityTier === "term-locked" && termLockedSuffix
            ? `${source.label} ${termLockedSuffix}`
            : source.label;

        await db
          .insert(assets)
          .values({
            connectedSourceId: source.id,
            currency: "EUR",
            currentValueMinor: holding.valueMinor,
            id: assetId,
            instrument,
            isPrimaryResidence: 0,
            liquidityTier: holding.liquidityTier,
            name,
            type: "manual",
          })
          .run();

        if (ownership.length > 0) {
          await db
            .insert(assetOwnerships)
            .values(
              ownership.map((share) => ({
                assetId,
                memberId: share.memberId,
                shareBps: share.shareBps,
              })),
            )
            .run();
        }

        // A connected source materializes this rung asset — register its
        // holding agent-view public id so the non-lazy read path never 500s (#335).
        await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(assetId));
      }

      if (holding.liquidityTier === (await assetTierOf(source.assetId))) {
        primaryValueMinor = holding.valueMinor;
      }
    }

    // Zero out any source asset on a rung the projection no longer occupies — keep
    // the row (snapshots/identity), just drop its live value to 0.
    for (const assetId of await listSourceAssetIds(source.id)) {
      const tier = await assetTierOf(assetId);
      if (tier && !projectedTiers.has(tier)) {
        await db
          .update(assets)
          .set({ currentValueMinor: 0, updatedAt: now })
          .where(eq(assets.id, assetId))
          .run();
      }
    }

    return primaryValueMinor;
  };

  return {
    connect: async (input) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) {
        throw new Error("Workspace must be initialized before connecting a source.");
      }

      const assetId = ctx.newId();
      const sourceId = ctx.newId();

      // The materialized holding the source projects into is the provider's
      // instrument and its default rung (ADR 0016/0021): Numista → an illiquid
      // coin_collection, Binance → a market-rung crypto holding. Branch on the
      // persisted tag (ADR 0043); the projection reads the same instrument, so the
      // materialized holding and the projected one never disagree.
      const instrument = instrumentForAdapter(input.adapter);
      const { rung } = defaultsFor(instrument);

      await ctx.transaction(async () => {
        // A derived holding valued from its positions (ADR 0016), never hand-set.
        // No valuation_method is set — it is nullable and derived at runtime from
        // the instrument, exactly like other asset rows.
        await db
          .insert(assets)
          .values({
            // Link the materialized asset back to its source (ADR 0016, #248): the
            // market (primary) asset is the source's default-rung holding; later
            // syncs materialize one asset per occupied rung, each carrying this id.
            connectedSourceId: sourceId,
            currency: "EUR",
            currentValueMinor: 0,
            id: assetId,
            instrument,
            isPrimaryResidence: 0,
            liquidityTier: rung,
            name: input.label,
            type: "manual",
          })
          .run();

        if (input.ownership.length > 0) {
          await db
            .insert(assetOwnerships)
            .values(
              input.ownership.map((share) => ({
                assetId,
                memberId: share.memberId,
                shareBps: share.shareBps,
              })),
            )
            .run();
        }

        await db
          .insert(connectedSources)
          .values({
            adapter: input.adapter,
            assetId,
            credentialsJson: sealSecret(input.credentialsJson),
            id: sourceId,
            label: input.label,
            lastSyncAt: null,
            tokenJson: null,
          })
          .run();

        // The market (primary) asset the source materializes is a holding —
        // register its agent-view public id so the read path never 500s (#335).
        await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(assetId));
      });

      await ctx.writeAuditEntry("connect_source", "connected_source", sourceId);

      return { assetId, sourceId };
    },
    saveToken: async (sourceId, tokenJson) => {
      await db
        .update(connectedSources)
        .set({ tokenJson: sealSecret(tokenJson), updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(connectedSources.id, sourceId))
        .run();
    },
    updateCredentials: async (sourceId, credentialsJson) => {
      await db
        .update(connectedSources)
        .set({
          credentialsJson: sealSecret(credentialsJson),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(connectedSources.id, sourceId))
        .run();
    },
    readSource,
    listSources: async () =>
      (
        await db
          .select(sourceColumns)
          .from(connectedSources)
          .orderBy(asc(connectedSources.createdAt), asc(connectedSources.id))
          .all()
      ).map(openRow),
    listSourceAssetIds,
    removeSourceHoldings: async (sourceId) => {
      const removed = await ctx.transaction(async () => {
        // ONE transaction: soft-delete then hard-delete every rung asset (market +
        // term-locked, including any trashed one). Deleting the market (primary)
        // asset cascades the source row + its positions away; the other-rung assets
        // have no back-FK, so they are removed explicitly. hardDeleteAssetTx only
        // deletes a TRASHED asset, so soft-delete each one (stamp deleted_at) first.
        const now = new Date().toISOString();
        let count = 0;
        for (const assetId of await listSourceAssetIds(sourceId)) {
          await db
            .update(assets)
            .set({ deletedAt: now })
            .where(eq(assets.id, assetId))
            .run();
          count += await hardDeleteAssetTx(ctx, assetId);
        }
        return count;
      });

      await ctx.writeAuditEntry("disconnect_source", "connected_source", sourceId, {
        removed,
      });

      return { removed };
    },
    readSourceIdForAsset,
    readPositions: readPositionsForSource,
    syncPositions: async (sourceId, incoming, syncedAt) => {
      await ctx.transaction(async () => {
        const source = await readSource(sourceId);
        if (!source) {
          throw new Error(`Connected source "${sourceId}" not found.`);
        }

        // Incremental mirror (ADR 0017): match on the stable `externalId`, update
        // existing lines in place (preserving internal ids), insert genuinely new
        // ones, and drop lines the provider no longer returns (a coin sold on
        // Numista). Wholesale delete+insert made every line look new to anything
        // keyed on internal id and forced unnecessary row churn.
        const existing = await readPositionsForSource(sourceId);
        const existingByExternal = new Map(
          existing.map((position) => [position.externalId, position]),
        );
        const incomingExternalIds = new Set(
          incoming.map((position) => position.externalId),
        );

        for (const position of existing) {
          if (!incomingExternalIds.has(position.externalId)) {
            await db.delete(positions).where(eq(positions.id, position.id)).run();
          }
        }

        const toInsert: SourcePosition[] = [];
        for (const draft of incoming) {
          const prior = existingByExternal.get(draft.externalId);
          const position: SourcePosition =
            draft.kind === "coin"
              ? { ...draft, id: prior?.id ?? ctx.newId(), sourceId }
              : { ...draft, id: prior?.id ?? ctx.newId(), sourceId };

          if (prior) {
            const { id: _id, ...updateSet } = positionInsertValues(position);
            await db
              .update(positions)
              .set(updateSet)
              .where(and(eq(positions.id, prior.id), eq(positions.sourceId, sourceId)))
              .run();
          } else {
            toInsert.push(position);
          }
        }

        if (toInsert.length > 0) {
          await db.insert(positions).values(toInsert.map(positionInsertValues)).run();
        }

        // Re-roll EVERY rung's holding from the freshly-written positions (ADR
        // 0016, #248), dispatched per kind (frozen coin vs live token): one asset
        // per occupied rung is updated/created, and a rung the source no longer
        // occupies is zeroed (kept for snapshots), never deleted.
        await rerollSourceHoldings(source);

        await db
          .update(connectedSources)
          .set({ lastSyncAt: syncedAt, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(connectedSources.id, sourceId))
          .run();
      });

      await ctx.writeAuditEntry("sync_source", "connected_source", sourceId, {
        positionCount: incoming.length,
      });
    },
    revaluePositions: async (sourceId, updates, freshness) => {
      await ctx.transaction(async () => {
        const source = await readSource(sourceId);
        if (!source) {
          throw new Error(`Connected source "${sourceId}" not found.`);
        }

        // Update each coin's candidate values in place — never adding or removing
        // lines (that is `syncPositions`' job). A position not in `updates` keeps
        // its stored values, so an outage that resolves nothing leaves them intact.
        for (const update of updates) {
          await db
            .update(positions)
            .set({
              metalValueMinor: update.metalValueMinor,
              numismaticValueMinor: update.numismaticValueMinor,
              numismaticFetchedAt: update.numismaticFetchedAt,
            })
            .where(and(eq(positions.id, update.id), eq(positions.sourceId, sourceId)))
            .run();
        }

        const valueMinor = await rerollSourceHoldings(source);

        // Upsert the holding's single valuation-freshness row, sourced by the
        // adapter ("numista" | "binance"): the staleness indicator the detail
        // surface reads, and the entry the daily stale-price pass selects to
        // trigger the next refresh. `price` carries the rolled-up value for parity
        // with other cache rows.
        const now = new Date().toISOString();
        const row = {
          assetId: source.assetId,
          currency: "EUR",
          fetchedAt: freshness.fetchedAt,
          freshnessState: freshness.freshnessState,
          price: String(valueMinor),
          source: source.adapter,
          staleReason: freshness.staleReason ?? null,
        };
        await db
          .insert(assetPriceCache)
          .values({ ...row, updatedAt: now })
          .onConflictDoUpdate({
            target: assetPriceCache.assetId,
            set: { ...row, updatedAt: now },
          })
          .run();
      });

      await ctx.writeAuditEntry("revalue_source", "connected_source", sourceId, {
        positionCount: updates.length,
      });
    },
    freezeIntoStoredHolding: async (sourceId) => {
      const source = await readSource(sourceId);
      if (!source) {
        return null;
      }

      // Every rung asset the source materialized — market + term-locked for
      // Binance, the single coin collection for Numista (#248). Captured BEFORE the
      // delete; deleting the source row leaves `assets.connected_source_id` intact
      // (no back-FK), so the lookup is unaffected, but read it up front for clarity.
      const assetIds = await listSourceAssetIds(sourceId);
      // The hand-valued instrument the holding flips to is explicit per provider
      // (ADR 0043): coin_collection → precious_metal, crypto → other.
      const frozenInstrument = frozenInstrumentForAdapter(source.adapter);

      await ctx.transaction(async () => {
        // Drop the source first — the FK cascade removes its positions. The assets
        // are NOT cascaded (sources reference the primary asset, not the other way
        // round), so every rolled-up holding survives with its last value intact.
        await db.delete(connectedSources).where(eq(connectedSources.id, sourceId)).run();

        for (const assetId of assetIds) {
          // Flip each rung asset from the derived/live source instrument to its
          // hand-valued counterpart (coin_collection → precious_metal, crypto →
          // other) and DETACH it (clear connected_source_id) so nothing routes it
          // back to the gone source or re-values it. `connect` left
          // valuation_method null and lets the runtime derive it from the
          // instrument, so flipping the instrument is what makes it hand-valued.
          await db
            .update(assets)
            .set({
              instrument: frozenInstrument,
              connectedSourceId: null,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(eq(assets.id, assetId))
            .run();

          // Clear the now-orphaned connected-source valuation-freshness row — a
          // stored holding is valued from its current value, not a cached price.
          await db
            .delete(assetPriceCache)
            .where(eq(assetPriceCache.assetId, assetId))
            .run();
        }
      });

      await ctx.writeAuditEntry("freeze_source", "connected_source", sourceId, {
        assetId: source.assetId,
        frozenAssets: assetIds.length,
      });

      return { assetId: source.assetId };
    },
  };
}
