import {
  buildHistoricalSnapshotDeps,
  readLiabilityIdentity,
} from "@db/historical-snapshot-deps";
import type { SaveSnapshotInput } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type { DebtBalanceCurveInputs, Workspace } from "@worthline/domain";
import {
  amortizationPaymentDatesUpTo,
  debtMissingFromAllGeneratedMessage,
  housingAssetIdsOf,
  rebaselineChainPaymentDatesUpTo,
  recalculateSnapshotForLiability,
} from "@worthline/domain";

import { type RippleDates, rippleBand } from "./ripple-band";
import { type DebtRippleCounts, EMPTY_DEBT_RIPPLE_COUNTS } from "./types";

// ── The debt family's band (PRD #109, ADR 0019 / ADR 0089) ───────────────────

/**
 * The band a debt change moves. A call site that knows both dates states them
 * outright as {@link RippleDates} — `eventBand(d)` for an anchor, and
 * `recalcOnlyBand(d)` for anything the curve no longer carries. The two shapes
 * that can only be read off the LIVE curve travel as a resolver instead, since
 * only the ripple holds the curve. There is no vocabulary of "kinds" in between
 * (#1590): a new debt fact adds a call site, not an arm in a union.
 */
export type DebtBandSpec =
  | RippleDates
  | ((curve: DebtBalanceCurveInputs, today: string) => RippleDates | null);

/**
 * The whole amortization schedule: one snapshot per past cuota boundary (the
 * deliberate ADR-0012 density exception of PRD #109), recalculating from the
 * disbursement date — the date the debt appears (ADR 0019). Null for an
 * amortizable debt with no plan row: there is no schedule to lay down.
 */
export const debtPlanBand: DebtBandSpec = (curve, today) =>
  curve.plan
    ? {
        eventDates: amortizationPaymentDatesUpTo(curve.plan, today),
        recalcFrom: curve.plan.disbursementDate,
      }
    : null;

/**
 * A re-baseline chain from `fromDateKey` on. UNIQUE dates across the whole chain
 * (#1435): each checkpoint's schedule runs to the contract end, so a long chain's
 * schedules overlap almost entirely and an un-deduplicated fan-out rebuilds the
 * same portfolio dozens of times.
 */
export function debtRebaselineChainBand(fromDateKey: string): DebtBandSpec {
  return (curve, today) => ({
    eventDates: rebaselineChainPaymentDatesUpTo(
      curve.balanceRebaselines ?? [],
      fromDateKey,
      today,
    ),
    recalcFrom: fromDateKey,
  });
}

/**
 * Ripple effect for debt-balance curves (PRD #109, slice 9): declaring, editing,
 * or deleting an amortization plan, a balance anchor, a re-baseline, a rate
 * revision or an early repayment regenerates / recalculates the snapshots the
 * change affects. The liability is valued from its debt curve (`debtBalanceAtDate`)
 * on each date; only its row moves, every other frozen row is preserved, and
 * legacy captures with no holding rows are skipped. A no-op when the liability has
 * no debt model / curve, or when the band resolves to nothing.
 *
 * The band runs inside THIS function's transaction, so the "the debt is missing
 * from every snapshot we just generated" refusal (#1438) rolls back everything it
 * wrote. El silencio es lo que costó dos días: también las salidas sin trabajo
 * dejan su línea en el log, igual que las que sí ripplean.
 */
export async function rippleHistoricalSnapshotsForDebt(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: { liabilityId: string; band: DebtBandSpec; today: string },
): Promise<DebtRippleCounts> {
  const { db } = ctx;
  const { liabilityId, today } = params;

  // The liability's identity — including trashed, since it existed on the
  // snapshot dates even if it was trashed afterwards.
  const liability = await readLiabilityIdentity(db, liabilityId);
  if (!liability) {
    console.info({ liabilityId }, "debt ripple: no identity, nothing to ripple");
    return EMPTY_DEBT_RIPPLE_COUNTS;
  }

  // Build deps once — the same for every scope (lesson from #114). The debt band
  // needs them for the curve itself, not only to generate, so they are read here
  // and handed to the band already resolved.
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  const curve = deps.debtBalanceByLiability.get(liabilityId);
  if (!curve || curve.debtModel === null) {
    console.info({ liabilityId }, "debt ripple: no debt model, nothing to ripple");
    return EMPTY_DEBT_RIPPLE_COUNTS;
  }

  const dates =
    typeof params.band === "function" ? params.band(curve, today) : params.band;
  if (dates === null) {
    console.info({ liabilityId }, "debt ripple: no band to lay down, nothing to ripple");
    return EMPTY_DEBT_RIPPLE_COUNTS;
  }

  // Housing assets — a debt securing one nets historical housing equity (ADR 0013).
  const housingAssetIds = housingAssetIdsOf(deps.assets);

  let generatedWithLiability = 0;
  return ctx.transaction(async () => {
    const band = await rippleBand(ctx, workspace, saveSnapshot, {
      generate: {
        dates: dates.eventDates,
        deps: async () => deps,
        onGenerated: (built) => {
          if (
            built.holdings.some(
              (row) => row.holdingId === liabilityId && row.kind === "liability",
            )
          ) {
            generatedWithLiability += 1;
          }
        },
        today,
      },
      recalcFrom: dates.recalcFrom,
      rewrite: ({ frozenHoldings, snapshot }) =>
        recalculateSnapshotForLiability({
          curve,
          frozenHoldings,
          housingAssetIds,
          liability,
          snapshot,
          workspace,
        }),
    });

    const counts: DebtRippleCounts = {
      generated: band.generated,
      generatedWithLiability,
      recalculated: band.recalculated,
    };
    // Log before the throw so the abort is not silent (#1438); this transaction
    // is the band's own (they flatten), so the rollback covers what it saved.
    logDebtRipple(liabilityId, counts);
    if (counts.generated > 0 && counts.generatedWithLiability === 0) {
      throw new Error(debtMissingFromAllGeneratedMessage(counts.generated));
    }
    return counts;
  });
}

function logDebtRipple(liabilityId: string, counts: DebtRippleCounts): void {
  const payload = { liabilityId, ...counts };
  if (counts.generated > 0 && counts.generatedWithLiability < counts.generated) {
    console.warn(
      "debt ripple omitted the liability from some generated snapshots",
      payload,
    );
    return;
  }
  console.info("debt ripple", payload);
}
