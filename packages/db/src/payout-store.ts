import type { Payout, PayoutCadence, PayoutSchedule } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import { payoutSchedules, payouts } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Payout persistence (PRD #652 / ADR 0054). Two fact types attached to one asset
 * holding: one-off **payouts** (a variable dividend, an extraordinary
 * distribution) and declared **payout schedules** (a fixed recurrence like rent).
 *
 * A payout is a pure attribution record — it touches no net-worth figure, no
 * snapshot, no ripple. Schedules store only the declaration; their occurrences are
 * derived on read by the domain (`deriveScheduleOccurrences`) and are NEVER
 * materialized as rows here. Exclusions live as a JSON array on the schedule,
 * following the exposure-profile `breakdownsJson` precedent.
 */

export interface CreatePayoutInput {
  holdingId: string;
  dateISO: string;
  amountMinor: number;
  note?: string;
}

export interface CreatePayoutScheduleInput {
  holdingId: string;
  label: string;
  amountMinor: number;
  cadence: PayoutCadence;
  startISO: string;
  endISO?: string | null;
  exclusions?: string[];
}

export interface UpdatePayoutSchedulePatch {
  label?: string;
  amountMinor?: number;
  cadence?: PayoutCadence;
  startISO?: string;
  endISO?: string | null;
  exclusions?: string[];
}

export interface PayoutStore {
  /** Every one-off payout, ordered by date then id (stable exports). */
  readPayouts: () => Promise<Payout[]>;
  readPayoutsForHolding: (holdingId: string) => Promise<Payout[]>;
  createPayout: (input: CreatePayoutInput) => Promise<Payout>;
  deletePayout: (id: string) => Promise<void>;
  /** Every declared schedule, ordered by holding then id. */
  readPayoutSchedules: () => Promise<PayoutSchedule[]>;
  readPayoutSchedulesForHolding: (holdingId: string) => Promise<PayoutSchedule[]>;
  createPayoutSchedule: (input: CreatePayoutScheduleInput) => Promise<PayoutSchedule>;
  updatePayoutSchedule: (id: string, patch: UpdatePayoutSchedulePatch) => Promise<void>;
  deletePayoutSchedule: (id: string) => Promise<void>;
}

export function createPayoutStore(ctx: StoreContext): PayoutStore {
  return {
    readPayouts: () => readPayouts(ctx),
    readPayoutsForHolding: (holdingId) => readPayouts(ctx, holdingId),
    createPayout: (input) => createPayout(ctx, input),
    deletePayout: (id) => deletePayout(ctx, id),
    readPayoutSchedules: () => readPayoutSchedules(ctx),
    readPayoutSchedulesForHolding: (holdingId) => readPayoutSchedules(ctx, holdingId),
    createPayoutSchedule: (input) => createPayoutSchedule(ctx, input),
    updatePayoutSchedule: (id, patch) => updatePayoutSchedule(ctx, id, patch),
    deletePayoutSchedule: (id) => deletePayoutSchedule(ctx, id),
  };
}

type PayoutRow = typeof payouts.$inferSelect;
type ScheduleRow = typeof payoutSchedules.$inferSelect;

function rowToPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    holdingId: row.holdingId,
    dateISO: row.date,
    amountMinor: row.amountMinor,
    ...(row.note != null ? { note: row.note } : {}),
  };
}

function rowToSchedule(row: ScheduleRow): PayoutSchedule {
  return {
    id: row.id,
    holdingId: row.holdingId,
    label: row.label,
    amountMinor: row.amountMinor,
    cadence: row.cadence,
    startISO: row.startDate,
    endISO: row.endDate,
    exclusions: JSON.parse(row.exclusionsJson) as string[],
  };
}

async function readPayouts(ctx: StoreContext, holdingId?: string): Promise<Payout[]> {
  const base = ctx.db.select().from(payouts);
  const rows = await (holdingId ? base.where(eq(payouts.holdingId, holdingId)) : base)
    .orderBy(asc(payouts.date), asc(payouts.id))
    .all();
  return rows.map(rowToPayout);
}

async function createPayout(
  ctx: StoreContext,
  input: CreatePayoutInput,
): Promise<Payout> {
  const id = ctx.newId();
  await ctx.db
    .insert(payouts)
    .values({
      id,
      holdingId: input.holdingId,
      date: input.dateISO,
      amountMinor: input.amountMinor,
      note: input.note ?? null,
    })
    .run();
  return {
    id,
    holdingId: input.holdingId,
    dateISO: input.dateISO,
    amountMinor: input.amountMinor,
    ...(input.note != null ? { note: input.note } : {}),
  };
}

async function deletePayout(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db.delete(payouts).where(eq(payouts.id, id)).run();
}

async function readPayoutSchedules(
  ctx: StoreContext,
  holdingId?: string,
): Promise<PayoutSchedule[]> {
  const base = ctx.db.select().from(payoutSchedules);
  const rows = await (holdingId
    ? base.where(eq(payoutSchedules.holdingId, holdingId))
    : base
  )
    .orderBy(asc(payoutSchedules.holdingId), asc(payoutSchedules.id))
    .all();
  return rows.map(rowToSchedule);
}

async function createPayoutSchedule(
  ctx: StoreContext,
  input: CreatePayoutScheduleInput,
): Promise<PayoutSchedule> {
  const id = ctx.newId();
  const endISO = input.endISO ?? null;
  const exclusions = input.exclusions ?? [];
  await ctx.db
    .insert(payoutSchedules)
    .values({
      id,
      holdingId: input.holdingId,
      label: input.label,
      amountMinor: input.amountMinor,
      cadence: input.cadence,
      startDate: input.startISO,
      endDate: endISO,
      exclusionsJson: JSON.stringify(exclusions),
    })
    .run();
  return {
    id,
    holdingId: input.holdingId,
    label: input.label,
    amountMinor: input.amountMinor,
    cadence: input.cadence,
    startISO: input.startISO,
    endISO,
    exclusions,
  };
}

async function updatePayoutSchedule(
  ctx: StoreContext,
  id: string,
  patch: UpdatePayoutSchedulePatch,
): Promise<void> {
  const set: Partial<typeof payoutSchedules.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.amountMinor !== undefined) set.amountMinor = patch.amountMinor;
  if (patch.cadence !== undefined) set.cadence = patch.cadence;
  if (patch.startISO !== undefined) set.startDate = patch.startISO;
  if (patch.endISO !== undefined) set.endDate = patch.endISO;
  if (patch.exclusions !== undefined)
    set.exclusionsJson = JSON.stringify(patch.exclusions);
  if (Object.keys(set).length === 0) return;
  await ctx.db.update(payoutSchedules).set(set).where(eq(payoutSchedules.id, id)).run();
}

async function deletePayoutSchedule(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db.delete(payoutSchedules).where(eq(payoutSchedules.id, id)).run();
}
