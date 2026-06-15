import type {
  ConnectedSource,
  OwnershipShare,
  PriceFreshnessState,
  SourceAdapter,
  SourcePosition,
} from "@worthline/domain";
import { projectConnectedSource } from "@worthline/domain";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  assetOwnerships,
  assetPriceCache,
  assets,
  connectedSources,
  positions,
} from "./schema";
import { readAssetOwnerships, type StoreContext } from "./store-context";

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

/** A position to persist — the store assigns id + sourceId. */
export type SourcePositionInput = Omit<SourcePosition, "id" | "sourceId">;

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
  connect(input: ConnectSourceInput): { sourceId: string; assetId: string };
  saveToken(sourceId: string, tokenJson: string): void;
  readSource(sourceId: string): ConnectedSourceRow | null;
  listSources(): ConnectedSourceRow[];
  readPositions(sourceId: string): SourcePosition[];
  /** Replace the source's positions, re-roll the holding's value, stamp last sync. */
  syncPositions(
    sourceId: string,
    positions: SourcePositionInput[],
    syncedAt: string,
  ): void;
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
  ): void;
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

export function createConnectedSourceStore(ctx: StoreContext): ConnectedSourceStore {
  const { db } = ctx;

  const readSource = (sourceId: string): ConnectedSourceRow | null =>
    db
      .select(sourceColumns)
      .from(connectedSources)
      .where(eq(connectedSources.id, sourceId))
      .get() ?? null;

  const readPositionsForSource = (sourceId: string): SourcePosition[] =>
    db
      .select()
      .from(positions)
      .where(eq(positions.sourceId, sourceId))
      .orderBy(asc(positions.createdAt), asc(positions.id))
      .all()
      .map((row) => ({
        catalogueId: row.catalogueId,
        currency: row.currency,
        finenessMillis: row.finenessMillis === null ? null : Number(row.finenessMillis),
        grade: row.grade,
        id: row.id,
        issueId: row.issueId === null ? null : Number(row.issueId),
        liquidityTier: row.liquidityTier,
        metal: row.metal,
        metalValueMinor:
          row.metalValueMinor === null ? null : Number(row.metalValueMinor),
        name: row.name,
        numismaticFetchedAt: row.numismaticFetchedAt,
        numismaticValueMinor:
          row.numismaticValueMinor === null ? null : Number(row.numismaticValueMinor),
        purchaseDate: row.purchaseDate,
        purchasePriceMinor:
          row.purchasePriceMinor === null ? null : Number(row.purchasePriceMinor),
        quantity: Number(row.quantity),
        sourceId,
        weightGrams: row.weightGrams === null ? null : Number(row.weightGrams),
      }));

  /** Re-roll the source's illiquid coin-collection holding from its positions
   *  (the single rung Numista occupies) and persist it on the materialized asset. */
  const rerollHoldingValue = (source: ConnectedSourceRow): number => {
    const domainSource: ConnectedSource = {
      adapter: source.adapter,
      id: source.id,
      label: source.label,
      ownership: readAssetOwnerships(db).get(source.assetId) ?? [],
    };
    const holdings = projectConnectedSource(
      domainSource,
      readPositionsForSource(source.id),
    );
    const valueMinor =
      holdings.find((holding) => holding.liquidityTier === "illiquid")?.valueMinor ?? 0;

    db.update(assets)
      .set({ currentValueMinor: valueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(assets.id, source.assetId))
      .run();

    return valueMinor;
  };

  return {
    connect: (input) => {
      const workspace = ctx.getWorkspace();
      if (!workspace) {
        throw new Error("Workspace must be initialized before connecting a source.");
      }

      const assetId = ctx.newId();
      const sourceId = ctx.newId();

      ctx.transaction(() => {
        // The materialized rolled-up holding the source projects into: a derived,
        // illiquid coin collection valued from its positions (ADR 0016). No
        // valuation_method is set — it is nullable and derived at runtime from the
        // instrument, exactly like other asset rows.
        db.insert(assets)
          .values({
            currency: "EUR",
            currentValueMinor: 0,
            id: assetId,
            instrument: "coin_collection",
            isPrimaryResidence: 0,
            liquidityTier: "illiquid",
            name: input.label,
            type: "manual",
          })
          .run();

        if (input.ownership.length > 0) {
          db.insert(assetOwnerships)
            .values(
              input.ownership.map((share) => ({
                assetId,
                memberId: share.memberId,
                shareBps: share.shareBps,
              })),
            )
            .run();
        }

        db.insert(connectedSources)
          .values({
            adapter: input.adapter,
            assetId,
            credentialsJson: input.credentialsJson,
            id: sourceId,
            label: input.label,
            lastSyncAt: null,
            tokenJson: null,
          })
          .run();
      });

      ctx.writeAuditEntry("connect_source", "connected_source", sourceId);

      return { assetId, sourceId };
    },
    saveToken: (sourceId, tokenJson) => {
      db.update(connectedSources)
        .set({ tokenJson, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(connectedSources.id, sourceId))
        .run();
    },
    readSource,
    listSources: () =>
      db
        .select(sourceColumns)
        .from(connectedSources)
        .orderBy(asc(connectedSources.createdAt), asc(connectedSources.id))
        .all(),
    readPositions: readPositionsForSource,
    syncPositions: (sourceId, incoming, syncedAt) => {
      ctx.transaction(() => {
        const source = readSource(sourceId);
        if (!source) {
          throw new Error(`Connected source "${sourceId}" not found.`);
        }

        // Replace the source's positions wholesale (a removed line drops out, a
        // new one appears), assigning each a fresh id + the source id.
        db.delete(positions).where(eq(positions.sourceId, sourceId)).run();

        const inserted: SourcePosition[] = incoming.map((position) => ({
          ...position,
          id: ctx.newId(),
          sourceId,
        }));

        if (inserted.length > 0) {
          db.insert(positions)
            .values(
              inserted.map((position) => ({
                catalogueId: position.catalogueId,
                currency: position.currency,
                finenessMillis: position.finenessMillis,
                grade: position.grade,
                id: position.id,
                issueId: position.issueId,
                liquidityTier: position.liquidityTier,
                metal: position.metal,
                metalValueMinor: position.metalValueMinor,
                name: position.name,
                numismaticFetchedAt: position.numismaticFetchedAt,
                numismaticValueMinor: position.numismaticValueMinor,
                purchaseDate: position.purchaseDate,
                purchasePriceMinor: position.purchasePriceMinor,
                quantity: position.quantity,
                sourceId,
                weightGrams: position.weightGrams,
              })),
            )
            .run();
        }

        // Re-roll the holding's value from the freshly-written positions (ADR
        // 0016). Numista's coins all sit on the single illiquid rung; the holding
        // derives 0 when the source now holds nothing.
        rerollHoldingValue(source);

        db.update(connectedSources)
          .set({ lastSyncAt: syncedAt, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(connectedSources.id, sourceId))
          .run();
      });

      ctx.writeAuditEntry("sync_source", "connected_source", sourceId, {
        positionCount: incoming.length,
      });
    },
    revaluePositions: (sourceId, updates, freshness) => {
      ctx.transaction(() => {
        const source = readSource(sourceId);
        if (!source) {
          throw new Error(`Connected source "${sourceId}" not found.`);
        }

        // Update each coin's candidate values in place — never adding or removing
        // lines (that is `syncPositions`' job). A position not in `updates` keeps
        // its stored values, so an outage that resolves nothing leaves them intact.
        for (const update of updates) {
          db.update(positions)
            .set({
              metalValueMinor: update.metalValueMinor,
              numismaticValueMinor: update.numismaticValueMinor,
              numismaticFetchedAt: update.numismaticFetchedAt,
            })
            .where(and(eq(positions.id, update.id), eq(positions.sourceId, sourceId)))
            .run();
        }

        const valueMinor = rerollHoldingValue(source);

        // Upsert the coin-collection's single valuation-freshness row (source
        // "numista"): the staleness indicator the detail surface reads, and the
        // entry the daily stale-price pass selects to trigger the next refresh.
        // `price` carries the rolled-up value for parity with other cache rows.
        const now = new Date().toISOString();
        const row = {
          assetId: source.assetId,
          currency: "EUR",
          fetchedAt: freshness.fetchedAt,
          freshnessState: freshness.freshnessState,
          price: String(valueMinor),
          source: "numista" as const,
          staleReason: freshness.staleReason ?? null,
        };
        db.insert(assetPriceCache)
          .values({ ...row, updatedAt: now })
          .onConflictDoUpdate({
            target: assetPriceCache.assetId,
            set: { ...row, updatedAt: now },
          })
          .run();
      });

      ctx.writeAuditEntry("revalue_source", "connected_source", sourceId, {
        positionCount: updates.length,
      });
    },
  };
}
