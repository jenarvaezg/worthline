import type {
  LeaseRegime,
  Payout,
  PayoutCadence,
  PayoutSchedule,
  PostMandatoryTermPolicy,
  RentRevision,
} from "@worthline/domain";
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

/**
 * The lease terms of a declared rent (#1521) — what its end date MEANS, how the rent
 * is revised, and what the owner does once the mandatory term is over. Every one of
 * them is nullable and `null` says «not declared», never a default in disguise.
 */
export interface PayoutScheduleLeaseTerms {
  leaseRegime?: LeaseRegime | null;
  rentRevision?: RentRevision | null;
  /** Documentary label for a `legal_reference` revision (e.g. IRAV); no engine reads it. */
  rentRevisionReference?: string | null;
  postMandatoryTermPolicy?: PostMandatoryTermPolicy | null;
}

export interface CreatePayoutScheduleInput extends PayoutScheduleLeaseTerms {
  holdingId: string;
  label: string;
  amountMinor: number;
  /** Declared cost per occurrence (#1448); omit / null for "not declared". */
  expensesMinor?: number | null;
  cadence: PayoutCadence;
  startISO: string;
  endISO?: string | null;
  exclusions?: string[];
}

export interface UpdatePayoutSchedulePatch extends PayoutScheduleLeaseTerms {
  label?: string;
  amountMinor?: number;
  /** `null` clears the declaration back to "not declared" — distinct from a declared 0. */
  expensesMinor?: number | null;
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
    expensesMinor: row.expensesMinor,
    cadence: row.cadence,
    startISO: row.startDate,
    endISO: row.endDate,
    leaseRegime: row.leaseRegime,
    rentRevision: row.rentRevision,
    rentRevisionReference: row.rentRevisionReference,
    postMandatoryTermPolicy: row.postMandatoryTermPolicy,
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
  const expensesMinor = input.expensesMinor ?? null;
  const leaseRegime = input.leaseRegime ?? null;
  const rentRevision = input.rentRevision ?? null;
  const rentRevisionReference = input.rentRevisionReference ?? null;
  const postMandatoryTermPolicy = input.postMandatoryTermPolicy ?? null;
  await ctx.db
    .insert(payoutSchedules)
    .values({
      id,
      holdingId: input.holdingId,
      label: input.label,
      amountMinor: input.amountMinor,
      expensesMinor,
      cadence: input.cadence,
      startDate: input.startISO,
      endDate: endISO,
      leaseRegime,
      rentRevision,
      rentRevisionReference,
      postMandatoryTermPolicy,
      exclusionsJson: JSON.stringify(exclusions),
    })
    .run();
  return {
    id,
    holdingId: input.holdingId,
    label: input.label,
    amountMinor: input.amountMinor,
    expensesMinor,
    cadence: input.cadence,
    startISO: input.startISO,
    endISO,
    leaseRegime,
    rentRevision,
    rentRevisionReference,
    postMandatoryTermPolicy,
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
  if (patch.expensesMinor !== undefined) set.expensesMinor = patch.expensesMinor;
  if (patch.cadence !== undefined) set.cadence = patch.cadence;
  if (patch.startISO !== undefined) set.startDate = patch.startISO;
  if (patch.endISO !== undefined) set.endDate = patch.endISO;
  // Each lease term is written only when the patch names it, so «guardar gastos» never
  // silently clears a regime the owner declared on the other form (#1521).
  if (patch.leaseRegime !== undefined) set.leaseRegime = patch.leaseRegime;
  if (patch.rentRevision !== undefined) set.rentRevision = patch.rentRevision;
  if (patch.rentRevisionReference !== undefined)
    set.rentRevisionReference = patch.rentRevisionReference;
  if (patch.postMandatoryTermPolicy !== undefined)
    set.postMandatoryTermPolicy = patch.postMandatoryTermPolicy;
  if (patch.exclusions !== undefined)
    set.exclusionsJson = JSON.stringify(patch.exclusions);
  if (Object.keys(set).length === 0) return;
  await ctx.db.update(payoutSchedules).set(set).where(eq(payoutSchedules.id, id)).run();
}

async function deletePayoutSchedule(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db.delete(payoutSchedules).where(eq(payoutSchedules.id, id)).run();
}
