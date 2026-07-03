import type {
  DebtBalanceCurveInputs,
  DebtModel,
  DecimalString,
  EarlyRepaymentMode,
  HousingCurveInputs,
  Liability,
  ManualAsset,
  ValuationCadence,
} from "@worthline/domain";
import { debtBalanceAtDate, isHousingAsset, valueHousingAtDate } from "@worthline/domain";

import {
  amortizationPlans,
  assets,
  assetValuations,
  earlyRepayments,
  interestRateRevisions,
  liabilities,
  liabilityBalanceAnchors,
  liabilityBalanceRebaselines,
} from "./schema";
import type { StoreDb } from "./store-context";

export interface CurveValuedLiveHoldings {
  assets: ManualAsset[];
  liabilities: Liability[];
}

export async function valueLiveHoldingsAtDate(
  db: StoreDb,
  liveAssets: readonly ManualAsset[],
  liveLiabilities: readonly Liability[],
  dateKey: string,
): Promise<CurveValuedLiveHoldings> {
  const [housingInputs, debtInputs] = await Promise.all([
    readHousingCurveInputs(db, liveAssets),
    readDebtBalanceInputs(db, liveLiabilities),
  ]);

  return {
    assets: liveAssets.map((asset) => {
      const curve = housingInputs.get(asset.id);
      if (!curve) return asset;
      return {
        ...asset,
        currentValue: {
          ...asset.currentValue,
          amountMinor: valueHousingAtDate({
            ...curve,
            targetDate: dateKey,
            today: dateKey,
          }),
        },
      };
    }),
    liabilities: liveLiabilities.map((liability) => {
      const curve = debtInputs.get(liability.id);
      if (!curve) return liability;
      return {
        ...liability,
        currentBalance: {
          ...liability.currentBalance,
          amountMinor: debtBalanceAtDate({
            ...curve,
            targetDate: dateKey,
          }),
        },
      };
    }),
  };
}

/**
 * Read the housing valuation curve inputs for every live real-estate asset
 * (PRD #108): its anchors, its annual appreciation rate, and its current value.
 * Keyed by asset id; only housing assets are included, and the domain decides
 * (via the anchors/rate presence) whether to value from the curve or fall back
 * to the last-known-value basis. `currentValue` comes from the already-read
 * assets so the curve uses the same value the live read derived.
 */
export async function readHousingCurveInputs(
  db: StoreDb,
  liveAssets: readonly ManualAsset[],
): Promise<Map<string, HousingCurveInputs>> {
  const housingAssets = liveAssets.filter((asset) => isHousingAsset(asset));
  const inputs = new Map<string, HousingCurveInputs>();
  if (housingAssets.length === 0) return inputs;

  const valuationRows = await db.select().from(assetValuations).all();
  const anchorsByAsset = new Map<string, HousingCurveInputs["anchors"][number][]>();
  for (const row of valuationRows) {
    const list = anchorsByAsset.get(row.assetId) ?? [];
    list.push({
      adjustsPriorCurve: row.adjustsPriorCurve === 1,
      valuationDate: row.valuationDate,
      valueMinor: row.valueMinor,
    });
    anchorsByAsset.set(row.assetId, list);
  }

  const rateRows = await db
    .select({
      id: assets.id,
      rate: assets.annualAppreciationRate,
      valuationCadence: assets.valuationCadence,
    })
    .from(assets)
    .all();
  const rateByAsset = new Map<string, DecimalString | null>();
  const cadenceByAsset = new Map<string, ValuationCadence | null>();
  for (const row of rateRows) {
    rateByAsset.set(row.id, row.rate);
    cadenceByAsset.set(row.id, row.valuationCadence ?? null);
  }

  for (const asset of housingAssets) {
    const cadence = cadenceByAsset.get(asset.id) ?? undefined;
    inputs.set(asset.id, {
      anchors: anchorsByAsset.get(asset.id) ?? [],
      annualAppreciationRate: rateByAsset.get(asset.id) ?? null,
      currentValueMinor: asset.currentValue.amountMinor,
      ...(cadence != null ? { cadence } : {}),
    });
  }

  return inputs;
}

/**
 * Read the debt-balance curve inputs for every live liability that carries a
 * debt model (PRD #109): its model, its balance anchors (revolving/informal),
 * its amortization plan + rate revisions (amortizable), and its current balance.
 * Keyed by liability id; only liabilities with a non-null model are included, so
 * a liability without a model keeps the last-known-value basis (no regression).
 * `currentBalance` comes from the already-read liabilities so the curve uses the
 * same fallback the live read derived.
 */
export async function readDebtBalanceInputs(
  db: StoreDb,
  liveLiabilities: readonly Liability[],
): Promise<Map<string, DebtBalanceCurveInputs>> {
  const inputs = new Map<string, DebtBalanceCurveInputs>();
  if (liveLiabilities.length === 0) return inputs;

  const modelRows = await db
    .select({
      id: liabilities.id,
      debtModel: liabilities.debtModel,
      valuationCadence: liabilities.valuationCadence,
    })
    .from(liabilities)
    .all();
  const modelById = new Map<string, DebtModel | null>();
  const cadenceById = new Map<string, ValuationCadence | null>();
  for (const row of modelRows) {
    modelById.set(row.id, row.debtModel ?? null);
    cadenceById.set(row.id, row.valuationCadence ?? null);
  }

  const anchorRows = await db.select().from(liabilityBalanceAnchors).all();
  const anchorsByLiability = new Map<
    string,
    { anchorDate: string; balanceMinor: number }[]
  >();
  for (const row of anchorRows) {
    const list = anchorsByLiability.get(row.liabilityId) ?? [];
    list.push({ anchorDate: row.anchorDate, balanceMinor: row.balanceMinor });
    anchorsByLiability.set(row.liabilityId, list);
  }

  const planRows = await db.select().from(amortizationPlans).all();
  const planByLiability = new Map<string, (typeof planRows)[number]>();
  for (const row of planRows) planByLiability.set(row.liabilityId, row);

  const revisionRows = await db.select().from(interestRateRevisions).all();
  const revisionsByPlan = new Map<
    string,
    { revisionDate: string; newAnnualInterestRate: DecimalString }[]
  >();
  for (const row of revisionRows) {
    const list = revisionsByPlan.get(row.planId) ?? [];
    list.push({
      newAnnualInterestRate: row.newAnnualInterestRate,
      revisionDate: row.revisionDate,
    });
    revisionsByPlan.set(row.planId, list);
  }

  const repaymentRows = await db.select().from(earlyRepayments).all();
  const repaymentsByPlan = new Map<
    string,
    { repaymentDate: string; amountMinor: number; mode: EarlyRepaymentMode }[]
  >();
  for (const row of repaymentRows) {
    const list = repaymentsByPlan.get(row.planId) ?? [];
    list.push({
      amountMinor: row.amountMinor,
      mode: row.mode,
      repaymentDate: row.repaymentDate,
    });
    repaymentsByPlan.set(row.planId, list);
  }

  const rebaselineRows = await db.select().from(liabilityBalanceRebaselines).all();
  const rebaselinesByLiability = new Map<
    string,
    {
      annualInterestRate: DecimalString;
      baselineDate: string;
      endDate: string;
      nextPaymentDate: string;
      outstandingBalanceMinor: number;
      startsAtBaseline: boolean;
    }[]
  >();
  for (const row of rebaselineRows) {
    const list = rebaselinesByLiability.get(row.liabilityId) ?? [];
    list.push({
      annualInterestRate: row.annualInterestRate,
      baselineDate: row.baselineDate,
      endDate: row.endDate,
      nextPaymentDate: row.nextPaymentDate,
      outstandingBalanceMinor: row.outstandingBalanceMinor,
      startsAtBaseline: row.startsAtBaseline,
    });
    rebaselinesByLiability.set(row.liabilityId, list);
  }

  for (const liability of liveLiabilities) {
    const debtModel = modelById.get(liability.id) ?? null;
    if (debtModel === null) continue;

    const currentBalanceMinor = liability.currentBalance.amountMinor;
    const cadence = cadenceById.get(liability.id) ?? undefined;

    if (debtModel === "amortizable") {
      const plan = planByLiability.get(liability.id);
      inputs.set(liability.id, {
        balanceRebaselines: rebaselinesByLiability.get(liability.id) ?? [],
        currentBalanceMinor,
        debtModel,
        ...(cadence != null ? { cadence } : {}),
        ...(plan
          ? {
              earlyRepayments: repaymentsByPlan.get(plan.id) ?? [],
              plan: {
                annualInterestRate: plan.annualInterestRate,
                disbursementDate: plan.disbursementDate,
                firstPaymentDate: plan.firstPaymentDate,
                initialCapitalMinor: plan.initialCapitalMinor,
                termMonths: plan.termMonths,
              },
              revisions: revisionsByPlan.get(plan.id) ?? [],
            }
          : {}),
      });
      continue;
    }

    inputs.set(liability.id, {
      anchors: anchorsByLiability.get(liability.id) ?? [],
      currentBalanceMinor,
      ...(cadence != null ? { cadence } : {}),
      debtModel,
    });
  }

  return inputs;
}
