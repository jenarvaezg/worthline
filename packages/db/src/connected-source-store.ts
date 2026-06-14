import type {
  ConnectedSource,
  OwnershipShare,
  SourceAdapter,
  SourcePosition,
} from "@worthline/domain";
import { projectConnectedSource } from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";

import { assetOwnerships, assets, connectedSources, positions } from "./schema";
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
    readPositions: (sourceId) =>
      db
        .select()
        .from(positions)
        .where(eq(positions.sourceId, sourceId))
        .orderBy(asc(positions.createdAt), asc(positions.id))
        .all()
        .map((row) => ({
          catalogueId: row.catalogueId,
          currency: row.currency,
          grade: row.grade,
          id: row.id,
          liquidityTier: row.liquidityTier,
          metal: row.metal,
          name: row.name,
          purchaseDate: row.purchaseDate,
          purchasePriceMinor:
            row.purchasePriceMinor === null ? null : Number(row.purchasePriceMinor),
          quantity: Number(row.quantity),
          sourceId,
        })),
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
                grade: position.grade,
                id: position.id,
                liquidityTier: position.liquidityTier,
                metal: position.metal,
                name: position.name,
                purchaseDate: position.purchaseDate,
                purchasePriceMinor: position.purchasePriceMinor,
                quantity: position.quantity,
                sourceId,
              })),
            )
            .run();
        }

        // Re-roll the holding's value from the projection (ADR 0016). Numista's
        // coins all sit on the single illiquid rung; take that holding's derived
        // value (0 when the source now holds nothing).
        const domainSource: ConnectedSource = {
          adapter: source.adapter,
          id: sourceId,
          label: source.label,
          ownership: readAssetOwnerships(db).get(source.assetId) ?? [],
        };
        const holdings = projectConnectedSource(domainSource, inserted);
        const illiquidHolding = holdings.find(
          (holding) => holding.liquidityTier === "illiquid",
        );
        const valueMinor = illiquidHolding?.valueMinor ?? 0;

        db.update(assets)
          .set({ currentValueMinor: valueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(assets.id, source.assetId))
          .run();

        db.update(connectedSources)
          .set({ lastSyncAt: syncedAt, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(connectedSources.id, sourceId))
          .run();
      });

      ctx.writeAuditEntry("sync_source", "connected_source", sourceId, {
        positionCount: incoming.length,
      });
    },
  };
}
