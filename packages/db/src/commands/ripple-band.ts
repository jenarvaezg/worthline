import {
  generateHistoricalBackfillIfMissing,
  groupFrozenHoldingsByDate,
  type HistoricalSnapshotDeps,
} from "@db/historical-snapshot-deps";
import { snapshots } from "@db/schema";
import {
  readSnapshotHoldings,
  readSnapshots,
  type SaveSnapshotInput,
  type SnapshotHoldingRecord,
} from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type {
  NetWorthSnapshot,
  ValuedNetWorthSnapshot,
  Workspace,
} from "@worthline/domain";
import { listScopeOptions } from "@worthline/domain";
import { eq } from "drizzle-orm";

import { pruneOrphanedBackfillSnapshot } from "./orphan-backfill-prune";

// ── The ripple band (ADR 0012, PRD #107, #1590) ──────────────────────────────
//
// Every family of dated facts — investment operations, housing valuations, debt
// curves, ownership splits, a mixed statement import — moves history the same
// way: generate the missing snapshot at each event date, then walk the existing
// snapshots forward from a floor, rewriting one holding's rows in each. That
// walk is THIS function, once. A family supplies identities, the dates it mints,
// the floor it recalculates from, and how one snapshot's rows are rewritten; it
// never re-writes the loop. The next family of dated facts does not clone it.

/**
 * How one snapshot's frozen rows are rewritten, in the family's own terms. The
 * three return values are the three things a ripple can do to a snapshot:
 *
 * - a `ValuedNetWorthSnapshot` → save it (replacing the frozen rows),
 * - `null` → no holdings remain, drop the snapshot,
 * - `undefined` → leave it exactly as it is (this family does not touch it).
 *
 * Pure and synchronous by construction: every read a rewrite needs (identities,
 * curves, frozen classification captures) is made once by the family BEFORE the
 * band starts, never per snapshot.
 */
export type RippleRewrite = (input: {
  snapshot: NetWorthSnapshot;
  frozenHoldings: SnapshotHoldingRecord[];
}) => ValuedNetWorthSnapshot | null | undefined;

/** What one band did, in snapshots. */
export interface RippleBandCounts {
  /** Fresh whole-portfolio `histsnap_` snapshots built at event dates. */
  generated: number;
  /** Existing snapshots whose rows were re-derived and saved. */
  recalculated: number;
  /** Orphaned `histsnap_` fossils dropped (#305). */
  pruned: number;
}

/** A band that never ran: nothing generated, nothing recalculated, nothing pruned. */
export const EMPTY_RIPPLE_BAND_COUNTS: RippleBandCounts = Object.freeze({
  generated: 0,
  pruned: 0,
  recalculated: 0,
});

/**
 * The two dates a change moves, which one word can never say at once: the dates
 * its facts MINT (a past one with no snapshot gets a fresh `histsnap_`, ADR 0012)
 * and the floor its recalculation starts FROM. They differ whenever a fact lands
 * inside a window it redraws — an early repayment steps the curve on its own date
 * (#1291) but reshapes the whole cuota cycle it falls in (#1042).
 */
export interface RippleDates {
  eventDates: readonly string[];
  recalcFrom: string;
}

/** A fact that mints its own date and recalculates from it — an anchor, an
 *  appraisal, a backdated order: the ordinary shape. */
export function eventBand(dateKey: string): RippleDates {
  return { eventDates: [dateKey], recalcFrom: dateKey };
}

/** A change that mints nothing and only redraws what is already there — every
 *  deletion (the curve no longer carries the fact), and a rate revision, which
 *  moves balances on existing dates without adding one. */
export function recalcOnlyBand(fromDateKey: string): RippleDates {
  return { eventDates: [], recalcFrom: fromDateKey };
}

export interface RippleBandSpec {
  /**
   * The dates this change's facts mint. Omitted entirely by a change with no date
   * axis — an ownership split moves no dates, it only re-weights (#172).
   *
   * `deps` is a THUNK, awaited at most once and only when a date actually needs
   * building: the common path — recording an operation dated today — mints
   * nothing, and must not pay for a whole-portfolio read it will not use. A
   * family that already holds deps for its own rewrite passes `async () => deps`.
   */
  generate?: {
    deps: () => Promise<HistoricalSnapshotDeps>;
    dates: readonly string[];
    today: string;
    /** Called per generated snapshot, so a family can inspect what got built. */
    onGenerated?: (built: ValuedNetWorthSnapshot) => void;
  };
  /**
   * The earliest existing snapshot the rewrite reaches. `null` means "every
   * date" — the ownership re-weight, whose affected set is decided by the
   * rewrite itself (it returns `undefined` for a date it does not carry).
   */
  recalcFrom: string | null;
  /**
   * Dates where a `histsnap_` may now be an orphan: deleting the last dated fact
   * on a date leaves a fossil frozen with stale holdings that the /historico
   * per-day bridge misreads as a phantom dip (#305). Checked BEFORE the rewrite,
   * so a still-present unrelated holding does not keep the orphan alive. A daily
   * capture, or a date any remaining dated fact still justifies, is never pruned
   * (guarded inside the prune).
   */
  pruneDates?: ReadonlySet<string>;
  rewrite: RippleRewrite;
  /**
   * Count what the band WOULD do and persist nothing (#1562). The whole walk
   * still runs — same scopes, same generation, same rewrites — so a preview built
   * on these counts is the same engine that does the writing, never a second one
   * that can disagree with it (#1438).
   *
   * Incompatible with `pruneDates` (throws): the prune decides by deleting, so it
   * cannot be counted without writing. No dry-run caller prunes.
   */
  dryRun?: boolean;
}

/**
 * Re-derive a band of historical snapshots (ADR 0012).
 *
 * Per scope, in this order: read the existing snapshots, generate the missing
 * past ones at the event dates, read the scope's frozen rows for the whole
 * affected range in ONE batched query (#205/#206/#1533), then walk the existing
 * snapshots from `recalcFrom` forward and rewrite each one.
 *
 * The order is load-bearing. `existing` is read BEFORE generation, so a snapshot
 * this band just minted is not also recalculated in the same pass — it was built
 * from the current facts already. The generated set grows as the loop saves, so
 * a date reaching the loop twice is built once (#1435). The batched frozen read
 * keeps the same ordering (dateKey, scopeId, kind, label, holdingId) as the
 * one-query-per-snapshot read it replaced, so each rewrite sees byte-identical
 * rows. A date with no frozen rows is a legacy capture predating holdings (ADR
 * 0008): there is nothing to recompute, so its figures are left untouched.
 *
 * The whole band — generation, prune and rewrites — commits or rolls back as one.
 * `ctx.transaction` flattens into an enclosing one, so a family that must refuse
 * its own result wraps the call and throws there: the rollback still covers every
 * snapshot the band saved (the debt band's "generated, but not one snapshot
 * carries the debt", #1438).
 */
export async function rippleBand(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  spec: RippleBandSpec,
): Promise<RippleBandCounts> {
  const { db } = ctx;
  const counts: RippleBandCounts = { generated: 0, pruned: 0, recalculated: 0 };
  // Built at most once for the whole band, across every scope (lesson from #114),
  // and never at all when no date needs generating.
  const generate = spec.generate;
  const dryRun = spec.dryRun === true;
  // A dry run cannot answer for a band that prunes: deciding whether a fossil is
  // an orphan IS the delete (`pruneOrphanedBackfillSnapshot`), so a counted run
  // would report the pruned snapshot as recalculated and disagree with the write
  // it claims to measure (#1438). Refused rather than silently approximated.
  if (dryRun && spec.pruneDates !== undefined) {
    throw new Error("rippleBand: a dry run cannot count a band that prunes.");
  }
  // ONE place decides what this run is allowed to write, so a future write added
  // to the walk cannot forget the dry-run guard.
  const writes = dryRun
    ? { drop: async () => {}, save: async () => {} }
    : {
        drop: async (snapshotId: string) => {
          await db.delete(snapshots).where(eq(snapshots.id, snapshotId)).run();
        },
        save: saveSnapshot,
      };
  let deps: HistoricalSnapshotDeps | null = null;

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
      // Dates that already have a snapshot — and it GROWS as this loop saves, so
      // a date reaching the loop twice is built once (#1435).
      const existingDates = new Set(existing.map(({ dateKey }) => dateKey));

      if (generate) {
        for (const dateKey of generate.dates) {
          // The generate seam re-checks both; asking here is what keeps the deps
          // thunk unawaited on a band that mints nothing.
          if (dateKey >= generate.today || existingDates.has(dateKey)) continue;
          const built = await generateHistoricalBackfillIfMissing({
            dateKey,
            deps: (deps ??= await generate.deps()),
            existingDates,
            saveSnapshot: writes.save,
            scopeId: scope.id,
            scopeLabel: scope.label,
            today: generate.today,
            workspace,
          });
          if (!built) continue;
          existingDates.add(dateKey);
          counts.generated += 1;
          generate.onGenerated?.(built);
        }
      }

      const frozenByDate = groupFrozenHoldingsByDate(
        await readSnapshotHoldings(db, {
          scopeId: scope.id,
          ...(spec.recalcFrom !== null ? { from: spec.recalcFrom } : {}),
        }),
      );

      for (const snapshot of existing) {
        if (spec.recalcFrom !== null && snapshot.dateKey < spec.recalcFrom) continue;

        if (
          spec.pruneDates?.has(snapshot.dateKey) === true &&
          (await pruneOrphanedBackfillSnapshot(db, snapshot))
        ) {
          counts.pruned += 1;
          continue;
        }

        const frozenHoldings = frozenByDate.get(snapshot.dateKey) ?? [];
        // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
        if (frozenHoldings.length === 0) continue;

        const rewritten = spec.rewrite({ frozenHoldings, snapshot });
        // The family does not touch this date — leave the frozen rows alone.
        if (rewritten === undefined) continue;
        if (rewritten === null) {
          await writes.drop(snapshot.id);
          continue;
        }

        await writes.save({
          holdings: rewritten.holdings,
          replace: true,
          snapshot: rewritten.snapshot,
        });
        counts.recalculated += 1;
      }
    }
  });

  return counts;
}
