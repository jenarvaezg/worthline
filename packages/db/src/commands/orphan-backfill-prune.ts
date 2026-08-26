import { BACKFILL_SNAPSHOT_ID_PREFIX } from "@db/historical-snapshot-deps";
import {
  amortizationPlans,
  assetOperations,
  assetValuations,
  connectedSources,
  earlyRepayments,
  interestRateRevisions,
  liabilityBalanceAnchors,
  liabilityBalanceRebaselines,
  positions,
  snapshots,
} from "@db/schema";
import type { StoreDb } from "@db/store-context";
import type { NetWorthSnapshot } from "@worthline/domain";
import {
  amortizationPaymentDatesUpTo,
  amortizationPlanFromBalanceRebaseline,
} from "@worthline/domain";
import { and, eq, like } from "drizzle-orm";

// ── Orphaned-backfill prune (#305, PR #326) ──────────────────────────────────
//
// The one question the ripple band asks before dropping a `histsnap_` fossil:
// does ANY dated fact still make this date an event date? Lives apart from the
// band because it is a query over every dated-fact table, not band mechanics.

/**
 * Is `dateKey` still an event date for ANY dated fact that mints a `histsnap_`
 * snapshot — not just an investment operation (#305, PR #326 review)? A backfilled
 * snapshot exists on a date only because SOME dated fact fell on it (ADR 0012);
 * the prune may drop it only when NONE remains. The fix is comprehensive: every
 * `histsnap_`-minting source is covered, mapped to its date source —
 *
 *  - Investment operations (the operations band, gap-fill):
 *    `asset_operations.executed_at` (ISO date or timestamp) LIKE `${dateKey}%` —
 *    the same `slice(0, 10)` basis every ripple keys on.
 *  - Housing valuation anchors (the valuation band):
 *    `asset_valuations.valuation_date = dateKey`.
 *  - Balance anchors — revolving/informal debt (the debt band):
 *    `liability_balance_anchors.anchor_date = dateKey`.
 *  - Interest-rate revisions (recalc only, but the revision date stays an event
 *    date): `interest_rate_revisions.revision_date`.
 *  - Early repayments: `early_repayments.repayment_date = dateKey`.
 *  - Connected-source coin acquisitions — Numista:
 *    `positions.purchase_date = dateKey` for a coin row.
 *  - Amortization payment boundaries — amortized debt: the date is COMPUTED, not
 *    stored (disbursement, or `firstPaymentDate + (m−1) months`). Reuse the domain
 *    helper `amortizationPaymentDatesUpTo` to rebuild each live plan's boundary
 *    set and test membership of `dateKey`.
 *  - Binance / connected-value history: its dates are month-ends of a curve
 *    RECONSTRUCTED LIVE at sync from the Binance + CoinGecko APIs — they are NOT
 *    persisted in any table, so they cannot be recomputed here. Conservative
 *    fallback (data loss is the failure mode to avoid): if ANY `binance`
 *    connected source exists, treat the date as justified and KEEP the snapshot.
 *    The prune then never deletes a snapshot a Binance history might justify.
 *
 * Conservative by construction: any uncertainty resolves to "justified" (keep).
 */
async function dateHasJustifyingFact(db: StoreDb, dateKey: string): Promise<boolean> {
  // Investment operations: executed_at as a date or timestamp → match the prefix.
  const storedFact = await db
    .select({ marker: assetOperations.id })
    .from(assetOperations)
    .where(like(assetOperations.executedAt, `${dateKey}%`))
    .limit(1)
    .get();
  if (storedFact !== undefined) return true;

  const valuationAnchor = await db
    .select({ marker: assetValuations.id })
    .from(assetValuations)
    .where(eq(assetValuations.valuationDate, dateKey))
    .limit(1)
    .get();
  if (valuationAnchor !== undefined) return true;

  const balanceAnchor = await db
    .select({ marker: liabilityBalanceAnchors.id })
    .from(liabilityBalanceAnchors)
    .where(eq(liabilityBalanceAnchors.anchorDate, dateKey))
    .limit(1)
    .get();
  if (balanceAnchor !== undefined) return true;

  const balanceRebaseline = await db
    .select({ marker: liabilityBalanceRebaselines.id })
    .from(liabilityBalanceRebaselines)
    .where(eq(liabilityBalanceRebaselines.baselineDate, dateKey))
    .limit(1)
    .get();
  if (balanceRebaseline !== undefined) return true;

  const revision = await db
    .select({ marker: interestRateRevisions.id })
    .from(interestRateRevisions)
    .where(eq(interestRateRevisions.revisionDate, dateKey))
    .limit(1)
    .get();
  if (revision !== undefined) return true;

  const repayment = await db
    .select({ marker: earlyRepayments.id })
    .from(earlyRepayments)
    .where(eq(earlyRepayments.repaymentDate, dateKey))
    .limit(1)
    .get();
  if (repayment !== undefined) return true;

  const coinAcquisition = await db
    .select({ marker: positions.id })
    .from(positions)
    .where(and(eq(positions.kind, "coin"), eq(positions.purchaseDate, dateKey)))
    .limit(1)
    .get();
  if (coinAcquisition !== undefined) return true;

  // Computed amortization payment boundaries: rebuild each live plan's boundary
  // set up to the day AFTER `dateKey` (the helper excludes dates ≥ its target),
  // so a boundary EQUAL to `dateKey` is included, and test membership.
  const targetAfterDate = dayAfter(dateKey);
  for (const plan of await db.select().from(amortizationPlans).all()) {
    const boundaries = amortizationPaymentDatesUpTo(
      {
        annualInterestRate: plan.annualInterestRate,
        disbursementDate: plan.disbursementDate,
        firstPaymentDate: plan.firstPaymentDate,
        initialCapitalMinor: plan.initialCapitalMinor,
        termMonths: plan.termMonths,
      },
      targetAfterDate,
    );
    if (boundaries.includes(dateKey)) return true;
  }

  for (const fact of await db.select().from(liabilityBalanceRebaselines).all()) {
    const boundaries = amortizationPaymentDatesUpTo(
      amortizationPlanFromBalanceRebaseline({
        annualInterestRate: fact.annualInterestRate,
        baselineDate: fact.baselineDate,
        endDate: fact.endDate,
        nextPaymentDate: fact.nextPaymentDate,
        outstandingBalanceMinor: fact.outstandingBalanceMinor,
        startsAtBaseline: fact.startsAtBaseline,
      }),
      targetAfterDate,
    );
    if (boundaries.includes(dateKey)) return true;
  }

  // Binance history: month-ends of a live-reconstructed curve, not stored. Cannot
  // recompute → keep when any binance source exists (conservative, #326).
  const binanceSource = await db
    .select({ marker: connectedSources.id })
    .from(connectedSources)
    .where(eq(connectedSources.adapter, "binance"))
    .limit(1)
    .get();
  if (binanceSource !== undefined) return true;

  return false;
}

/** The YYYY-MM-DD calendar day immediately after `dateKey` (handles month/year
 *  rollover; used only to make `amortizationPaymentDatesUpTo` include a boundary
 *  EQUAL to `dateKey`, since the helper excludes dates ≥ its target). */
function dayAfter(dateKey: string): string {
  const next = new Date(`${dateKey}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Prune a now-orphaned backfilled snapshot (#305): when deleting an operation
 * leaves a `histsnap_` snapshot on a date no operation justifies any more — and
 * it is not a real daily capture — drop the snapshot. Its frozen holding rows go
 * with it via the `snapshot_holdings.snapshot_id` ON DELETE cascade (ADR 0008),
 * for whichever scope's snapshot this is; the band iterates every scope. Runs in
 * the band's transaction so the prune commits or rolls back with the ripple.
 * Conservative by construction: returns true (pruned) ONLY for a backfilled id on
 * a date NO remaining dated fact justifies (`dateHasJustifyingFact` covers every
 * `histsnap_`-minting source, #326); in every other case it leaves the snapshot
 * untouched.
 */
export async function pruneOrphanedBackfillSnapshot(
  db: StoreDb,
  snapshot: NetWorthSnapshot,
): Promise<boolean> {
  if (!snapshot.id.startsWith(BACKFILL_SNAPSHOT_ID_PREFIX)) return false;
  if (await dateHasJustifyingFact(db, snapshot.dateKey)) return false;
  await db.delete(snapshots).where(eq(snapshots.id, snapshot.id)).run();
  return true;
}
