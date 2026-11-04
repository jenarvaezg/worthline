/**
 * The persistence of a connected source that OWNS its holdings through operations
 * instead of mirroring a value (ADR 0115) — MyInvestor, the first. It lives apart
 * from the mirroring lifecycle in `connected-source-store.ts` (ADR 0043): it has
 * no mirror asset, no positions and no projection, and its login can stop halfway
 * for an SMS.
 *
 * - The connection is a `connected_sources` row with `asset_id` NULL (v74). Its
 *   holdings arrive later (#1880) and point back by `assets.connected_source_id`.
 * - The half-done login of the two-step SMS is a `connected_source_pending_logins`
 *   row (ADR 0114 decision 6): sealed, with an expiry, one per adapter.
 * - Every secret is sealed at rest (ADR 0030): the credentials and the pending step.
 */
import type { InvestmentOperation, SourceAdapter } from "@worthline/domain";
import {
  asDateKey,
  compareInvestmentOperations,
  isMirroredSourceAdapter,
  isRealCalendarDay,
} from "@worthline/domain";
import { and, asc, eq, lt, sql } from "drizzle-orm";

import { openSecret, sealSecret } from "./crypto";
import {
  assets,
  connectedSourceDiscoveries,
  connectedSourceLinks,
  connectedSourcePendingLogins,
  connectedSources,
  connectorAppliedFacts,
  factBatchReplacedOperations,
} from "./schema";
import type { StoreContext } from "./store-context";

/** A source that owns its holdings: today, only MyInvestor. */
export type OwningSourceAdapter = Exclude<SourceAdapter, "numista" | "binance">;

export interface ConnectOwningSourceInput {
  adapter: OwningSourceAdapter;
  label: string;
  /** Plain JSON; sealed here before it reaches the database. */
  credentialsJson: string;
}

export interface StartPendingLoginInput {
  adapter: OwningSourceAdapter;
  /** Plain JSON of the pending step; sealed here. */
  payloadJson: string;
  /** ISO instant after which the step no longer counts. */
  expiresAt: string;
}

/** A pending login as read back: payload opened. Whether it expired is the caller's call. */
export interface PendingLoginRow {
  id: string;
  adapter: SourceAdapter;
  payloadJson: string;
  expiresAt: string;
}

/**
 * Write the connection, or null when the workspace already has one of this
 * adapter: the check and the insert share a transaction, and the partial unique
 * index of v74 refuses a second row should two logins still race past it.
 */
export async function connectOwningSource(
  ctx: StoreContext,
  input: ConnectOwningSourceInput,
): Promise<{ sourceId: string } | null> {
  const sourceId = ctx.newId();
  const written = await ctx.transaction(async () => {
    const existing = await ctx.db
      .select({ id: connectedSources.id })
      .from(connectedSources)
      .where(eq(connectedSources.adapter, input.adapter))
      .get();
    if (existing) return false;
    await ctx.db
      .insert(connectedSources)
      .values({
        adapter: input.adapter,
        assetId: null,
        credentialsJson: sealSecret(input.credentialsJson),
        id: sourceId,
        label: input.label,
        lastSyncAt: null,
        tokenJson: null,
      })
      .run();
    return true;
  });
  if (!written) return null;
  await ctx.writeAuditEntry("connect_source", "connected_source", sourceId);
  return { sourceId };
}

/**
 * Write the pending step, replacing any previous one of the same adapter in the
 * same transaction: a workspace has one connection per adapter, so the newest
 * login attempt is the only one that can still finish.
 */
export async function startPendingLogin(
  ctx: StoreContext,
  input: StartPendingLoginInput,
): Promise<{ id: string }> {
  const id = ctx.newId();
  await ctx.transaction(async () => {
    await ctx.db
      .delete(connectedSourcePendingLogins)
      .where(eq(connectedSourcePendingLogins.adapter, input.adapter))
      .run();
    await ctx.db
      .insert(connectedSourcePendingLogins)
      .values({
        adapter: input.adapter,
        expiresAt: input.expiresAt,
        id,
        payloadJson: sealSecret(input.payloadJson),
      })
      .run();
  });
  return { id };
}

export async function readPendingLogin(
  ctx: StoreContext,
  id: string,
): Promise<PendingLoginRow | null> {
  const row = await ctx.db
    .select({
      adapter: connectedSourcePendingLogins.adapter,
      expiresAt: connectedSourcePendingLogins.expiresAt,
      id: connectedSourcePendingLogins.id,
      payloadJson: connectedSourcePendingLogins.payloadJson,
    })
    .from(connectedSourcePendingLogins)
    .where(eq(connectedSourcePendingLogins.id, id))
    .get();
  return row ? { ...row, payloadJson: openSecret(row.payloadJson) } : null;
}

/**
 * Reserve one code attempt of a pending step, in ONE update, before MyInvestor is
 * asked: the number of this attempt (1-based), or null when the step is unknown or
 * already spent its `cap`. Read-then-write around the call to MyInvestor would let
 * codes sent at once all read the same count and slip past the cap.
 */
export async function reservePendingCodeAttempt(
  ctx: StoreContext,
  id: string,
  cap: number,
): Promise<number | null> {
  const reserved = await ctx.db
    .update(connectedSourcePendingLogins)
    .set({ attempts: sql`${connectedSourcePendingLogins.attempts} + 1` })
    .where(
      and(
        eq(connectedSourcePendingLogins.id, id),
        lt(connectedSourcePendingLogins.attempts, cap),
      ),
    )
    .returning({ attempts: connectedSourcePendingLogins.attempts })
    .all();
  const row = reserved[0];
  return row ? Number(row.attempts) : null;
}

/**
 * Delete every pending step already expired at `now` (ISO, same format as
 * `expires_at`, so the text comparison is the time comparison). A tab closed on
 * the SMS step leaves its row behind — with the credentials, when the box was
 * ticked — and nothing else would ever touch it: the daily capture sweeps them.
 */
export async function purgeExpiredPendingLogins(
  ctx: StoreContext,
  now: string,
): Promise<number> {
  const expired = await ctx.db
    .delete(connectedSourcePendingLogins)
    .where(lt(connectedSourcePendingLogins.expiresAt, now))
    .returning({ id: connectedSourcePendingLogins.id })
    .all();
  return expired.length;
}

export async function deletePendingLogin(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db
    .delete(connectedSourcePendingLogins)
    .where(eq(connectedSourcePendingLogins.id, id))
    .run();
}

/** What an owning source found the last time it was read (#1880). */
export interface SourceDiscoveryRow {
  /** The day of the read, `YYYY-MM-DD`. */
  readOn: string;
  /** The adapter's own document; its shape belongs to the adapter's module. */
  payloadJson: string;
}

/** One linked holding of an owning source: which product it is (#1880). */
export interface SourceLinkRow {
  productKey: string;
  assetId: string;
}

/**
 * Keep what the read found, replacing the previous read, and stamp the source's
 * last good sync with the instant of the read: a read that got this far is one.
 * Null when the id names no owning source.
 */
export async function saveSourceDiscovery(
  ctx: StoreContext,
  input: { sourceId: string; readOn: string; payloadJson: string; readAt: string },
): Promise<{ saved: true } | null> {
  // The day of the read becomes the ingestion cursor, compared as text with other
  // days: an instant here would sort after its own day. Refused, not truncated.
  if (!isRealCalendarDay(input.readOn)) {
    throw new Error(`A discovery is read on a calendar day, got "${input.readOn}".`);
  }
  const readOn = asDateKey(input.readOn);
  const source = await ctx.db
    .select({ adapter: connectedSources.adapter })
    .from(connectedSources)
    .where(eq(connectedSources.id, input.sourceId))
    .get();
  if (!source || isMirroredSourceAdapter(source.adapter)) return null;

  await ctx.transaction(async () => {
    await ctx.db
      .insert(connectedSourceDiscoveries)
      .values({
        payloadJson: input.payloadJson,
        readOn,
        sourceId: input.sourceId,
      })
      .onConflictDoUpdate({
        set: { payloadJson: input.payloadJson, readOn },
        target: connectedSourceDiscoveries.sourceId,
      })
      .run();
    await ctx.db
      .update(connectedSources)
      .set({ lastSyncAt: input.readAt, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(connectedSources.id, input.sourceId))
      .run();
  });
  return { saved: true };
}

export async function readSourceDiscovery(
  ctx: StoreContext,
  sourceId: string,
): Promise<SourceDiscoveryRow | null> {
  const row = await ctx.db
    .select({
      payloadJson: connectedSourceDiscoveries.payloadJson,
      readOn: connectedSourceDiscoveries.readOn,
    })
    .from(connectedSourceDiscoveries)
    .where(eq(connectedSourceDiscoveries.sourceId, sourceId))
    .get();
  return row ?? null;
}

/** The source's linked holdings, by product, oldest link first. */
export async function readSourceLinks(
  ctx: StoreContext,
  sourceId: string,
): Promise<SourceLinkRow[]> {
  return ctx.db
    .select({
      assetId: connectedSourceLinks.assetId,
      productKey: connectedSourceLinks.productKey,
    })
    .from(connectedSourceLinks)
    .where(eq(connectedSourceLinks.sourceId, sourceId))
    .orderBy(asc(connectedSourceLinks.createdAt), asc(connectedSourceLinks.productKey))
    .all();
}

/** The dedup ledger of the source: every fact key it already applied. */
export async function readAppliedFactKeys(
  ctx: StoreContext,
  sourceId: string,
): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ factKey: connectorAppliedFacts.factKey })
    .from(connectorAppliedFacts)
    .where(eq(connectorAppliedFacts.sourceId, sourceId))
    .all();
  return new Set(rows.map((row) => row.factKey));
}

/** One manual operation a link replaced, with the batch that replaced it (#1881). */
export interface ReplacedOperationRow {
  batchId: string;
  operation: InvestmentOperation;
}

/**
 * What linking a holding to an owning source replaced (#1881, ADR 0115 decision 6):
 * its manual operations as they were, in ledger order, each with the linking batch.
 * Provenance only — nothing folds these — and it outlives a disconnect.
 */
export async function readReplacedOperations(
  ctx: StoreContext,
  assetId: string,
): Promise<ReplacedOperationRow[]> {
  const rows = await ctx.db
    .select({
      batchId: factBatchReplacedOperations.batchId,
      operationJson: factBatchReplacedOperations.operationJson,
    })
    .from(factBatchReplacedOperations)
    .where(eq(factBatchReplacedOperations.assetId, assetId))
    .all();
  return rows
    .map((row) => ({
      batchId: row.batchId,
      operation: JSON.parse(row.operationJson) as InvestmentOperation,
    }))
    .sort((left, right) => compareInvestmentOperations(left.operation, right.operation));
}

/**
 * Disconnect an owning source (ADR 0115 decision 6): the row goes — and with it
 * the sealed credentials, at once — and every holding it owned is FROZEN as manual:
 * detached from the source, with its value, its operations and its own instrument
 * (a fund stays a fund). Any pending login of the adapter goes too. Null when the
 * id is unknown or names a mirroring source, which disconnects through its own
 * remove/freeze fork.
 */
export async function disconnectOwningSource(
  ctx: StoreContext,
  sourceId: string,
): Promise<{ frozen: number } | null> {
  const source = await ctx.db
    .select({ adapter: connectedSources.adapter })
    .from(connectedSources)
    .where(eq(connectedSources.id, sourceId))
    .get();
  if (!source || isMirroredSourceAdapter(source.adapter)) return null;

  const frozen = await ctx.transaction(async () => {
    const linked = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.connectedSourceId, sourceId))
      .all();
    await ctx.db
      .update(assets)
      .set({ connectedSourceId: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(assets.connectedSourceId, sourceId))
      .run();
    await ctx.db.delete(connectedSources).where(eq(connectedSources.id, sourceId)).run();
    await ctx.db
      .delete(connectedSourcePendingLogins)
      .where(eq(connectedSourcePendingLogins.adapter, source.adapter))
      .run();
    return linked.length;
  });

  await ctx.writeAuditEntry("disconnect_source", "connected_source", sourceId, {
    frozen,
  });
  return { frozen };
}
