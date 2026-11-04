/**
 * The sync state of a source that owns its holdings (#1884, ADR 0114 decisions 4
 * and 7): the `connected_source_sync_state` row of v78. Every write that guards a
 * limit is ONE statement, so two passes started at once cannot both slip past it:
 *
 * - {@link claimSyncLease}: one pass per connection. The lease is taken only when it
 *   is free or expired, and a pass killed halfway loses it when it expires.
 * - {@link reserveSyncLogin}: one of the day's logins, reserved before MyInvestor is
 *   asked, so the cap of 10 holds whatever runs at once.
 *
 * - {@link recordPasswordRejection}: the action of a rejected password (decision 7)
 *   in ONE transaction — the saved password deleted, the rejection counted, the lock
 *   and the outcome written — so a half-applied rejection can neither keep a
 *   password the cron would retry nor count a third rejection with no lock.
 *
 * The rest is what the passes leave for the button, the cron and the ficha to read.
 * A login day is a calendar day (`DateKey`), refused otherwise: an instant there
 * would never equal the next one, and the caps would reset on every login.
 */
import type { DateKey, OwningSourceStop } from "@worthline/domain";
import { isRealCalendarDay, owningSourceStop } from "@worthline/domain";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import { openSecret, sealSecret } from "./crypto";
import { connectedSourceSyncState, connectedSources, syncRuns } from "./schema";
import type { StoreContext } from "./store-context";
import type { SyncRunError } from "./sync-run-store";

export type SyncLeaseTrigger = "manual" | "cron";

/** The pass that holds a connection, as the waiting button and the panel see it. */
export interface SyncLease {
  /** ISO instant after which the lease no longer counts. */
  until: string;
  startedAt: string;
  trigger: SyncLeaseTrigger;
  /** The step the pass is on; null before its first. */
  step: string | null;
}

export type ClaimSyncLeaseResult =
  | { claimed: true }
  | { claimed: false; held: SyncLease };

export interface SourceSyncState {
  sourceId: string;
  /**
   * The pass that last took the connection, or null when it was released. An
   * expired lease is still returned: whether it still counts is the caller's clock.
   */
  lease: SyncLease | null;
  loginDay: string | null;
  loginsToday: number;
  rejectionsToday: number;
  pausedUntil: string | null;
  stoppedReason: string | null;
  lastOutcomeJson: string | null;
  unitsCheckJson: string | null;
}

/** The fields a pass may set; `null` clears one, an absent key leaves it as it is. */
export interface SourceSyncStatePatch {
  pausedUntil?: string | null;
  stoppedReason?: string | null;
  lastOutcomeJson?: string | null;
  unitsCheckJson?: string | null;
}

type StateRow = typeof connectedSourceSyncState.$inferSelect;

function leaseOf(row: StateRow): SyncLease | null {
  if (row.leaseUntil === null || row.leaseStartedAt === null || !row.leaseTrigger) {
    return null;
  }
  return {
    startedAt: row.leaseStartedAt,
    step: row.leaseStep,
    trigger: row.leaseTrigger,
    until: row.leaseUntil,
  };
}

/** The row exists before any guarded update reaches it. */
async function ensureRow(ctx: StoreContext, sourceId: string): Promise<void> {
  await ctx.db
    .insert(connectedSourceSyncState)
    .values({ sourceId })
    .onConflictDoNothing()
    .run();
}

/**
 * Take the connection for one pass, or say who holds it. ISO instants compare as
 * text, so `lease_until <= now` is the time comparison.
 */
export async function claimSyncLease(
  ctx: StoreContext,
  input: { sourceId: string; now: string; until: string; trigger: SyncLeaseTrigger },
): Promise<ClaimSyncLeaseResult> {
  await ensureRow(ctx, input.sourceId);
  const table = connectedSourceSyncState;
  const taken = await ctx.db
    .update(table)
    .set({
      leaseStartedAt: input.now,
      leaseStep: null,
      leaseTrigger: input.trigger,
      leaseUntil: input.until,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(table.sourceId, input.sourceId),
        or(isNull(table.leaseUntil), lte(table.leaseUntil, input.now)),
      ),
    )
    .returning({ sourceId: table.sourceId })
    .all();
  if (taken.length > 0) return { claimed: true };

  const row = await ctx.db
    .select()
    .from(table)
    .where(eq(table.sourceId, input.sourceId))
    .get();
  const held = row ? leaseOf(row) : null;
  // Released between the update and this read: the caller may simply try again.
  return held ? { claimed: false, held } : claimSyncLease(ctx, input);
}

export async function setSyncStep(
  ctx: StoreContext,
  sourceId: string,
  step: string,
): Promise<void> {
  await ctx.db
    .update(connectedSourceSyncState)
    .set({ leaseStep: step })
    .where(eq(connectedSourceSyncState.sourceId, sourceId))
    .run();
}

export async function releaseSyncLease(
  ctx: StoreContext,
  sourceId: string,
): Promise<void> {
  await ctx.db
    .update(connectedSourceSyncState)
    .set({
      leaseStartedAt: null,
      leaseStep: null,
      leaseTrigger: null,
      leaseUntil: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(connectedSourceSyncState.sourceId, sourceId))
    .run();
}

/**
 * Reserve one login of `day`: its number (1-based), or null when the day already
 * spent its `cap`. A new day starts the count, and the day's rejections, again.
 */
export async function reserveSyncLogin(
  ctx: StoreContext,
  input: { sourceId: string; day: DateKey; cap: number },
): Promise<number | null> {
  assertLoginDay(input.day);
  await ensureRow(ctx, input.sourceId);
  const table = connectedSourceSyncState;
  const sameDay = sql`${table.loginDay} = ${input.day}`;
  const reserved = await ctx.db
    .update(table)
    .set({
      loginDay: input.day,
      loginsToday: sql`CASE WHEN ${sameDay} THEN ${table.loginsToday} + 1 ELSE 1 END`,
      rejectionsToday: sql`CASE WHEN ${sameDay} THEN ${table.rejectionsToday} ELSE 0 END`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(table.sourceId, input.sourceId),
        sql`(${table.loginDay} IS NULL OR ${table.loginDay} <> ${input.day} OR ${table.loginsToday} < ${input.cap})`,
      ),
    )
    .returning({ loginsToday: table.loginsToday })
    .all();
  const row = reserved[0];
  return row ? Number(row.loginsToday) : null;
}

function assertLoginDay(day: string): void {
  if (!isRealCalendarDay(day)) {
    throw new Error(`A login day is a calendar day, got "${day}".`);
  }
}

/** What a rejected password leaves, decided by how many the day already has. */
export interface PasswordRejectionInput {
  sourceId: string;
  day: DateKey;
  /** The credentials without the password, when a saved one is deleted; null otherwise. */
  credentialsJson: string | null;
  /** Rejections in a day that lock the connection. */
  lockAfter: number;
  /** Until when a lock holds: the start of the next day. */
  lockedUntil: string;
  /** The outcome to keep for a plain rejection, and for the one that locks. */
  outcomeJson: { rejected: string; locked: string };
}

/**
 * A rejected password (ADR 0114 decision 7), all of it or none: the saved password
 * goes, the rejection is counted, and the third of the day pauses the connection
 * until `lockedUntil`. Returns the day's count and whether it locked.
 */
export async function recordPasswordRejection(
  ctx: StoreContext,
  input: PasswordRejectionInput,
): Promise<{ rejections: number; locked: boolean }> {
  assertLoginDay(input.day);
  return ctx.transaction(async () => {
    await ensureRow(ctx, input.sourceId);
    if (input.credentialsJson !== null) {
      await ctx.db
        .update(connectedSources)
        .set({
          credentialsJson: sealSecret(input.credentialsJson),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(connectedSources.id, input.sourceId))
        .run();
    }
    const table = connectedSourceSyncState;
    const sameDay = sql`${table.loginDay} = ${input.day}`;
    const counted = await ctx.db
      .update(table)
      .set({
        loginDay: input.day,
        rejectionsToday: sql`CASE WHEN ${sameDay} THEN ${table.rejectionsToday} + 1 ELSE 1 END`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(table.sourceId, input.sourceId))
      .returning({ rejectionsToday: table.rejectionsToday })
      .all();
    const rejections = Number(counted[0]?.rejectionsToday ?? 1);
    const locked = rejections >= input.lockAfter;
    await ctx.db
      .update(table)
      .set({
        lastOutcomeJson: locked ? input.outcomeJson.locked : input.outcomeJson.rejected,
        ...(locked ? { pausedUntil: input.lockedUntil } : {}),
      })
      .where(eq(table.sourceId, input.sourceId))
      .run();
    return { locked, rejections };
  });
}

export async function updateSyncState(
  ctx: StoreContext,
  sourceId: string,
  patch: SourceSyncStatePatch,
): Promise<void> {
  await ensureRow(ctx, sourceId);
  await ctx.db
    .update(connectedSourceSyncState)
    .set({ ...patch, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(connectedSourceSyncState.sourceId, sourceId))
    .run();
}

/** The state of a source, or null when no pass ever touched it. */
export async function readSyncState(
  ctx: StoreContext,
  sourceId: string,
): Promise<SourceSyncState | null> {
  const row = await ctx.db
    .select()
    .from(connectedSourceSyncState)
    .where(eq(connectedSourceSyncState.sourceId, sourceId))
    .get();
  if (!row) return null;
  return {
    lastOutcomeJson: row.lastOutcomeJson,
    lease: leaseOf(row),
    loginDay: row.loginDay,
    loginsToday: Number(row.loginsToday),
    pausedUntil: row.pausedUntil,
    rejectionsToday: Number(row.rejectionsToday),
    sourceId: row.sourceId,
    stoppedReason: row.stoppedReason,
    unitsCheckJson: row.unitsCheckJson,
  };
}

/**
 * How long the attempt log of a source that owns its holdings is kept (#1885, ADR
 * 0114 decision 8). By DAYS, not by the last N rows the mirroring sources keep: the
 * health rule counts days in a row, and ten presses of the button a day would eat
 * twenty rows in two.
 */
export const SYNC_ATTEMPT_RETENTION_DAYS = 90;

/** One finished attempt of a pass, as the log keeps it. */
export interface SyncAttemptInput {
  sourceId: string;
  trigger: SyncLeaseTrigger;
  /** When the pass started: the row's `created_at` and `started_at`. */
  startedAt: string;
  finishedAt: string;
  /**
   * Null for a good pass. A failure carries only words of ours: the error's kind,
   * the outcome, the step and the HTTP status — never an amount, an ISIN nor an
   * identifier, which the type has no field for.
   */
  error: SyncRunError | null;
}

function retentionCutoff(now: string): string {
  return new Date(
    Date.parse(now) - SYNC_ATTEMPT_RETENTION_DAYS * 86_400_000,
  ).toISOString();
}

/** Delete a source's attempts older than {@link SYNC_ATTEMPT_RETENTION_DAYS} at `now`. */
export async function purgeSyncAttempts(
  ctx: StoreContext,
  input: { sourceId: string; now: string },
): Promise<void> {
  await ctx.db
    .delete(syncRuns)
    .where(
      and(
        eq(syncRuns.sourceId, input.sourceId),
        lt(syncRuns.createdAt, retentionCutoff(input.now)),
      ),
    )
    .run();
}

/**
 * Write one finished attempt to `sync_run` (extended, not a new table, #1885) and
 * purge what the retention leaves behind, in one transaction. The row is written
 * whole when the pass ends, never opened `running` first: the lease already keeps
 * one pass per connection, and a pass killed halfway would leave a row nobody ends.
 * It does not touch `last_sync_at`: the pass stamps that with the read it saved.
 */
export async function recordSyncAttempt(
  ctx: StoreContext,
  input: SyncAttemptInput,
): Promise<void> {
  await ctx.transaction(async () => {
    await ctx.db
      .insert(syncRuns)
      .values({
        createdAt: input.startedAt,
        errorJson: input.error === null ? null : JSON.stringify(input.error),
        finishedAt: input.finishedAt,
        id: ctx.newId(),
        sourceId: input.sourceId,
        startedAt: input.startedAt,
        status: input.error === null ? "ok" : "error",
        trigger: input.trigger,
      })
      .run();
    await purgeSyncAttempts(ctx, { now: input.finishedAt, sourceId: input.sourceId });
  });
}

/**
 * What the sync state of a source that owns its holdings says beyond its log, for
 * data health (#1885): whether a password is saved and why the periodic sync is
 * stopped. Null for a mirroring source (it has a mirror asset). Only the two facts
 * cross: the credentials are opened here to ask whether they hold a password, and
 * nothing of them leaves.
 */
export async function readOwningSourceStanding(
  ctx: StoreContext,
  sourceId: string,
): Promise<{ savedPassword: boolean; stop: OwningSourceStop | null } | null> {
  const source = await ctx.db
    .select({
      assetId: connectedSources.assetId,
      credentialsJson: connectedSources.credentialsJson,
    })
    .from(connectedSources)
    .where(eq(connectedSources.id, sourceId))
    .get();
  if (!source || source.assetId !== null) return null;
  const state = await readSyncState(ctx, sourceId);
  const savedPassword = carriesPassword(openSecret(source.credentialsJson));
  return {
    savedPassword,
    stop: owningSourceStop({
      lastOutcome: outcomeHeadOf(state?.lastOutcomeJson ?? null),
      savedPassword,
      stoppedReason: state?.stoppedReason ?? null,
    }),
  };
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether stored credentials remember a password (the opt-in of ADR 0114 decision 1). */
function carriesPassword(credentialsJson: string): boolean {
  const parsed = parseObject(credentialsJson);
  return typeof parsed?.password === "string" && parsed.password.length > 0;
}

/** The kind of the last outcome and whether it forgot the saved password; nothing else. */
function outcomeHeadOf(
  json: string | null,
): { kind: string; forgotten: boolean | null } | null {
  const parsed = parseObject(json);
  if (typeof parsed?.kind !== "string") return null;
  return {
    forgotten: typeof parsed.forgotten === "boolean" ? parsed.forgotten : null,
    kind: parsed.kind,
  };
}
