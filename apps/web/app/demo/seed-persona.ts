/**
 * Persona seed builder (PRD #297, ADR 0029) — the deepest demo module.
 *
 * `seedPersona(store, spec, asOf)` constructs a persona's workspace ENTIRELY
 * through the public store API and the dated-fact / ripple seams (ADR 0020). The
 * history is produced by the ripple engine and the backfill — never by writing
 * snapshot rows directly — so the demo can never drift from how the engine
 * actually behaves. Every spec date is RELATIVE to `asOf` (the pinned demo
 * clock), so bumping the demo's "now" regenerates a coherent history.
 *
 * Prior art: tests/performance-harness-seeds.ts and e2e/global-setup.ts seed
 * through these same seams.
 */

import type {
  BinanceHistoryMonthSpec,
  ConnectedSourceSpec,
  HousingSpec,
  InvestmentSpec,
  LiabilitySpec,
  MortgageSpec,
  PersonaSpec,
  RelativeDate,
} from "@web/demo/spec-types";
import type { WorthlineStore } from "@worthline/db";
import type { BinanceHistoryCurve, CurrencyCode, DecimalString } from "@worthline/domain";
import { amortizableBalanceAtDate, valueHousingAtDate } from "@worthline/domain";

const DEFAULT_CURRENCY: CurrencyCode = "EUR";

interface SeededConnectedSource {
  sourceId: string;
  spec: ConnectedSourceSpec;
}

/** Resolve a relative offset to a YYYY-MM-DD date-key, anchored at `asOf`. */
export function resolveRelativeDate(asOf: string, when: RelativeDate): string {
  const base = new Date(`${asOf}T00:00:00.000Z`);
  const months = (when.yearsAgo ?? 0) * 12 + (when.monthsAgo ?? 0);
  if (months) base.setUTCMonth(base.getUTCMonth() - months);
  if (when.daysAgo) base.setUTCDate(base.getUTCDate() - when.daysAgo);
  return base.toISOString().slice(0, 10);
}

async function seedInvestment(
  store: WorthlineStore,
  investment: InvestmentSpec,
  asOf: string,
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: investment.currency ?? DEFAULT_CURRENCY,
    id: investment.id,
    manualPricePerUnit: investment.manualPricePerUnit,
    name: investment.name,
    ownership: investment.ownership,
    ...(investment.unitSymbol ? { unitSymbol: investment.unitSymbol } : {}),
    ...(investment.liquidityTier ? { liquidityTier: investment.liquidityTier } : {}),
  });

  for (const op of investment.operations) {
    await store.command.recordInvestmentOperation(
      {
        assetId: investment.id,
        currency: investment.currency ?? DEFAULT_CURRENCY,
        executedAt: resolveRelativeDate(asOf, op.at),
        id: op.id,
        kind: op.kind,
        pricePerUnit: op.pricePerUnit,
        units: op.units,
        ...(op.feesMinor === undefined ? {} : { feesMinor: op.feesMinor }),
      },
      { today: asOf },
    );
  }
}

async function seedMortgage(
  store: WorthlineStore,
  housingId: string,
  mortgage: MortgageSpec,
  asOf: string,
): Promise<void> {
  await store.liabilities.createLiability({
    associatedAssetId: housingId,
    balanceMinor: mortgage.initialCapitalMinor,
    currency: DEFAULT_CURRENCY,
    id: mortgage.liabilityId,
    name: mortgage.name,
    ownership: mortgage.ownership,
    type: "mortgage",
  });
  await store.liabilities.setDebtModel(mortgage.liabilityId, "amortizable");

  const plan = {
    annualInterestRate: mortgage.annualInterestRate,
    disbursementDate: resolveRelativeDate(asOf, mortgage.disbursement),
    firstPaymentDate: resolveRelativeDate(asOf, mortgage.firstPayment),
    initialCapitalMinor: mortgage.initialCapitalMinor,
    termMonths: mortgage.termMonths,
  };
  const earlyRepayments = (mortgage.earlyRepayments ?? []).map((repayment) => ({
    amountMinor: repayment.amountMinor,
    id: repayment.id,
    mode: repayment.mode,
    repaymentDate: resolveRelativeDate(asOf, repayment.at),
  }));

  // Persist plan + ripple per-cuota snapshots ride the debt seam together.
  await store.command.createAmortizationPlan(
    {
      ...plan,
      id: mortgage.planId,
      liabilityId: mortgage.liabilityId,
    },
    { today: asOf },
  );

  for (const repayment of earlyRepayments) {
    await store.command.addEarlyRepayment(
      {
        amountMinor: repayment.amountMinor,
        id: repayment.id,
        mode: repayment.mode,
        planId: mortgage.planId,
        repaymentDate: repayment.repaymentDate,
      },
      { liabilityId: mortgage.liabilityId, today: asOf },
    );
  }

  await store.liabilities.updateLiabilityBalance(
    mortgage.liabilityId,
    amortizableBalanceAtDate({
      earlyRepayments,
      plan,
      targetDate: asOf,
    }),
  );
}

async function seedHousing(
  store: WorthlineStore,
  housing: HousingSpec,
  asOf: string,
): Promise<void> {
  const currency = housing.currency ?? DEFAULT_CURRENCY;
  const acquisitionDate = resolveRelativeDate(asOf, housing.acquisition.at);
  const improvementAnchors = (housing.improvements ?? []).map((improvement) => ({
    ...improvement,
    valuationDate: resolveRelativeDate(asOf, improvement.at),
  }));
  const currentValueMinor = valueHousingAtDate({
    anchors: [
      {
        adjustsPriorCurve: true,
        valuationDate: acquisitionDate,
        valueMinor: housing.acquisition.valueMinor,
      },
      ...improvementAnchors.map((improvement) => ({
        adjustsPriorCurve: false,
        valuationDate: improvement.valuationDate,
        valueMinor: improvement.valueMinor,
      })),
    ],
    annualAppreciationRate: housing.annualAppreciationRate ?? null,
    currentValueMinor: housing.acquisition.valueMinor,
    targetDate: asOf,
    today: asOf,
  });

  await store.command.createHousingHolding(
    {
      acquisitionAnchor: {
        adjustsPriorCurve: true,
        assetId: housing.id,
        id: `${housing.id}_acquisition`,
        valuationDate: acquisitionDate,
        valueMinor: housing.acquisition.valueMinor,
      },
      annualAppreciationRate: housing.annualAppreciationRate ?? null,
      asset: {
        currency,
        currentValueMinor,
        id: housing.id,
        isPrimaryResidence: housing.isPrimaryResidence ?? false,
        liquidityTier: housing.liquidityTier ?? "housing",
        name: housing.name,
        ownership: housing.ownership,
        type: "real_estate",
      },
    },
    { today: asOf },
  );

  for (const improvement of improvementAnchors) {
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: false,
        assetId: housing.id,
        id: improvement.id,
        valuationDate: improvement.valuationDate,
        valueMinor: improvement.valueMinor,
      },
      { today: asOf },
    );
  }

  if (housing.mortgage) {
    await seedMortgage(store, housing.id, housing.mortgage, asOf);
  }
}

async function seedLiability(
  store: WorthlineStore,
  liability: LiabilitySpec,
  asOf: string,
): Promise<void> {
  await store.liabilities.createLiability({
    balanceMinor: liability.balanceMinor,
    currency: liability.currency ?? DEFAULT_CURRENCY,
    id: liability.id,
    name: liability.name,
    ownership: liability.ownership,
    type: "debt",
  });

  if (liability.model) {
    await store.liabilities.setDebtModel(liability.id, liability.model);
  }

  for (const anchor of liability.balanceAnchors ?? []) {
    await store.command.addBalanceAnchor(
      {
        anchorDate: resolveRelativeDate(asOf, anchor.at),
        balanceMinor: anchor.balanceMinor,
        id: anchor.id,
        liabilityId: liability.id,
      },
      { today: asOf },
    );
  }
}

async function seedConnectedSource(
  store: WorthlineStore,
  source: ConnectedSourceSpec,
  asOf: string,
): Promise<SeededConnectedSource> {
  const { sourceId } = await store.connectedSources.connect({
    adapter: source.adapter,
    credentialsJson: source.credentialsJson ?? "{}",
    label: source.label,
    ownership: source.ownership,
  });
  // Synced once with fixed positions; never refreshed (demo refreshers are no-ops),
  // so the mirror's valuation is frozen in the fixture.
  const syncedAt = `${resolveRelativeDate(asOf, source.syncedAt)}T12:00:00.000Z`;
  await store.connectedSources.syncPositions(sourceId, source.positions, syncedAt);
  return { sourceId, spec: source };
}

function monthKeyMonthsAgo(asOf: string, monthsAgo: number): string {
  const base = new Date(`${asOf}T00:00:00.000Z`);
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() - monthsAgo);
  return base.toISOString().slice(0, 7);
}

function lastDayOfMonthKey(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

function setNestedDecimal(
  map: Map<string, Map<string, DecimalString>>,
  symbol: string,
  key: string,
  value: DecimalString,
): void {
  const existing = map.get(symbol);
  if (existing) {
    existing.set(key, value);
    return;
  }

  map.set(symbol, new Map([[key, value]]));
}

function buildBinanceHistoryCurve(
  asOf: string,
  history: BinanceHistoryMonthSpec[],
): BinanceHistoryCurve {
  const monthEndBalances = new Map<string, Map<string, DecimalString>>();
  const dailyPriceBySymbol = new Map<string, Map<string, DecimalString>>();

  for (const month of history) {
    const monthKey = monthKeyMonthsAgo(asOf, month.monthsAgo);
    const dateKey = lastDayOfMonthKey(monthKey);
    for (const [symbol, balance] of Object.entries(month.balances)) {
      setNestedDecimal(monthEndBalances, symbol, monthKey, balance);
    }
    for (const [symbol, price] of Object.entries(month.prices)) {
      setNestedDecimal(dailyPriceBySymbol, symbol, dateKey, price);
    }
  }

  return { dailyPriceBySymbol, monthEndBalances };
}

async function applyConnectedSourceHistory(
  store: WorthlineStore,
  seeded: SeededConnectedSource,
  asOf: string,
): Promise<void> {
  if (seeded.spec.adapter !== "binance" || !seeded.spec.binanceHistory) return;

  await store.command.applyBinanceHistory({
    curve: buildBinanceHistoryCurve(asOf, seeded.spec.binanceHistory),
    sourceId: seeded.sourceId,
    today: asOf,
  });
}

/**
 * Seed `spec` into `store`, generating its history relative to `asOf`
 * (YYYY-MM-DD). Deterministic and network-free — no provider is ever touched.
 */
export async function seedPersona(
  store: WorthlineStore,
  spec: PersonaSpec,
  asOf: string,
): Promise<void> {
  await store.workspace.initializeWorkspace({ members: spec.members, mode: spec.mode });

  for (const manual of spec.manualAssets ?? []) {
    await store.assets.createManualAsset({
      currency: manual.currency ?? DEFAULT_CURRENCY,
      currentValueMinor: manual.valueMinor,
      id: manual.id,
      liquidityTier: manual.liquidityTier,
      name: manual.name,
      ownership: manual.ownership,
      type: manual.type,
    });
  }

  for (const investment of spec.investments ?? []) {
    await seedInvestment(store, investment, asOf);
  }

  for (const housing of spec.housing ?? []) {
    await seedHousing(store, housing, asOf);
  }

  for (const liability of spec.liabilities ?? []) {
    await seedLiability(store, liability, asOf);
  }

  const seededSources: SeededConnectedSource[] = [];
  for (const source of spec.connectedSources ?? []) {
    seededSources.push(await seedConnectedSource(store, source, asOf));
  }

  for (const fire of spec.fire ?? []) {
    await store.saveFireConfig(fire.scopeId, fire.config);
  }

  // Fill every gap between the milestone facts above and `asOf` so the Evolución
  // curve is a believable monthly history, not a sparse scatter (ADR 0012 backfill).
  await store.command.backfillHistoricalSnapshots(asOf);

  for (const seeded of seededSources) {
    await applyConnectedSourceHistory(store, seeded, asOf);
  }
}
