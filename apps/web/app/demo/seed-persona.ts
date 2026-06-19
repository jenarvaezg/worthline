/**
 * Persona seed builder (PRD #297, ADR 0023) — the deepest demo module.
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
import type { WorthlineStore } from "@worthline/db";
import type { CurrencyCode } from "@worthline/domain";

import type {
  ConnectedSourceSpec,
  HousingSpec,
  InvestmentSpec,
  LiabilitySpec,
  MortgageSpec,
  PersonaSpec,
  RelativeDate,
} from "@web/demo/spec-types";

const DEFAULT_CURRENCY: CurrencyCode = "EUR";

/** Resolve a relative offset to a YYYY-MM-DD date-key, anchored at `asOf`. */
export function resolveRelativeDate(asOf: string, when: RelativeDate): string {
  const base = new Date(`${asOf}T00:00:00.000Z`);
  const months = (when.yearsAgo ?? 0) * 12 + (when.monthsAgo ?? 0);
  if (months) base.setUTCMonth(base.getUTCMonth() - months);
  if (when.daysAgo) base.setUTCDate(base.getUTCDate() - when.daysAgo);
  return base.toISOString().slice(0, 10);
}

function seedInvestment(
  store: WorthlineStore,
  investment: InvestmentSpec,
  asOf: string,
): void {
  store.assets.createInvestmentAsset({
    currency: investment.currency ?? DEFAULT_CURRENCY,
    id: investment.id,
    manualPricePerUnit: investment.manualPricePerUnit,
    name: investment.name,
    ownership: investment.ownership,
    ...(investment.unitSymbol ? { unitSymbol: investment.unitSymbol } : {}),
    ...(investment.liquidityTier ? { liquidityTier: investment.liquidityTier } : {}),
  });

  for (const op of investment.operations) {
    store.recordOperationAndRipple(
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

function seedMortgage(
  store: WorthlineStore,
  housingId: string,
  mortgage: MortgageSpec,
  asOf: string,
): void {
  store.liabilities.createLiability({
    associatedAssetId: housingId,
    balanceMinor: mortgage.initialCapitalMinor,
    currency: DEFAULT_CURRENCY,
    id: mortgage.liabilityId,
    name: mortgage.name,
    ownership: mortgage.ownership,
    type: "mortgage",
  });
  store.liabilities.setDebtModel(mortgage.liabilityId, "amortizable");

  // Persist plan + ripple per-cuota snapshots ride the debt seam together.
  store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: mortgage.annualInterestRate,
      disbursementDate: resolveRelativeDate(asOf, mortgage.disbursement),
      firstPaymentDate: resolveRelativeDate(asOf, mortgage.firstPayment),
      id: mortgage.planId,
      initialCapitalMinor: mortgage.initialCapitalMinor,
      liabilityId: mortgage.liabilityId,
      termMonths: mortgage.termMonths,
    },
    { today: asOf },
  );

  for (const repayment of mortgage.earlyRepayments ?? []) {
    store.addEarlyRepaymentAndRipple(
      {
        amountMinor: repayment.amountMinor,
        id: repayment.id,
        mode: repayment.mode,
        planId: mortgage.planId,
        repaymentDate: resolveRelativeDate(asOf, repayment.at),
      },
      { liabilityId: mortgage.liabilityId, today: asOf },
    );
  }
}

function seedHousing(store: WorthlineStore, housing: HousingSpec, asOf: string): void {
  const currency = housing.currency ?? DEFAULT_CURRENCY;
  const acquisitionDate = resolveRelativeDate(asOf, housing.acquisition.at);

  store.createHousingHoldingAndRipple(
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
        currentValueMinor: housing.acquisition.valueMinor,
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

  for (const improvement of housing.improvements ?? []) {
    store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: false,
        assetId: housing.id,
        id: improvement.id,
        valuationDate: resolveRelativeDate(asOf, improvement.at),
        valueMinor: improvement.valueMinor,
      },
      { today: asOf },
    );
  }

  if (housing.mortgage) {
    seedMortgage(store, housing.id, housing.mortgage, asOf);
  }
}

function seedLiability(
  store: WorthlineStore,
  liability: LiabilitySpec,
  asOf: string,
): void {
  store.liabilities.createLiability({
    balanceMinor: liability.balanceMinor,
    currency: liability.currency ?? DEFAULT_CURRENCY,
    id: liability.id,
    name: liability.name,
    ownership: liability.ownership,
    type: "debt",
  });

  if (liability.model) {
    store.liabilities.setDebtModel(liability.id, liability.model);
  }

  for (const anchor of liability.balanceAnchors ?? []) {
    store.liabilities.addBalanceAnchor({
      anchorDate: resolveRelativeDate(asOf, anchor.at),
      balanceMinor: anchor.balanceMinor,
      id: anchor.id,
      liabilityId: liability.id,
    });
  }
}

function seedConnectedSource(
  store: WorthlineStore,
  source: ConnectedSourceSpec,
  asOf: string,
): void {
  const { sourceId } = store.connectedSources.connect({
    adapter: source.adapter,
    credentialsJson: source.credentialsJson ?? "{}",
    label: source.label,
    ownership: source.ownership,
  });
  // Synced once with fixed positions; never refreshed (demo refreshers are no-ops),
  // so the mirror's valuation is frozen in the fixture.
  const syncedAt = `${resolveRelativeDate(asOf, source.syncedAt)}T12:00:00.000Z`;
  store.connectedSources.syncPositions(sourceId, source.positions, syncedAt);
}

/**
 * Seed `spec` into `store`, generating its history relative to `asOf`
 * (YYYY-MM-DD). Deterministic and network-free — no provider is ever touched.
 */
export function seedPersona(
  store: WorthlineStore,
  spec: PersonaSpec,
  asOf: string,
): void {
  store.workspace.initializeWorkspace({ members: spec.members, mode: spec.mode });

  for (const manual of spec.manualAssets ?? []) {
    store.assets.createManualAsset({
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
    seedInvestment(store, investment, asOf);
  }

  for (const housing of spec.housing ?? []) {
    seedHousing(store, housing, asOf);
  }

  for (const liability of spec.liabilities ?? []) {
    seedLiability(store, liability, asOf);
  }

  for (const source of spec.connectedSources ?? []) {
    seedConnectedSource(store, source, asOf);
  }

  for (const fire of spec.fire ?? []) {
    store.saveFireConfig(fire.scopeId, fire.config);
  }

  // Fill every gap between the milestone facts above and `asOf` so the Evolución
  // curve is a believable monthly history, not a sparse scatter (ADR 0012 backfill).
  store.backfillHistoricalSnapshots(asOf);
}
