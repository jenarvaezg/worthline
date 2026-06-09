import type { CurrencyCode } from "./money";
import type { DecimalString } from "./decimal";
import type { LocalPersistenceStatus } from "./dashboard";
import type { LiquidityTier } from "./classification";
import type { MoneyMinor } from "./money";

import { addMoney, assertMinorInteger, money, subtractMoney } from "./money";
import { deriveMonthlyCloses } from "./snapshot-policy";

export type { CurrencyCode, MoneyMinor } from "./money";
export {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  money,
  moneySign,
  parseDecimal,
  parseDecimalStrict,
  parseDecimalToMinor,
  parseDecimalToMinorStrict,
  subtractMoney,
} from "./money";

import {
  isHousing,
  isHousingAsset,
  isLiquid,
  tierOfAsset,
  tierOfLiability,
} from "./classification";

export type { LiquidityTier } from "./classification";
export {
  isHousing,
  isHousingAsset,
  isLiquid,
  tierOfAsset,
  tierOfLiability,
} from "./classification";

export { createInvestmentOperation, createInvestmentOperationSafe, derivePosition } from "./positions";
export type {
  InvestmentPriceSource,
  SelectedInvestmentPrice,
  DeriveInvestmentValuationInput,
  InvestmentValuation,
} from "./investment-valuation";
export {
  assertNotInvestmentAsset,
  deriveInvestmentValuation,
  selectInvestmentPrice,
} from "./investment-valuation";

export type { AssetPrice, PriceFreshnessState, PriceSource } from "./prices";
export { getPriceFreshness, PRICE_TTL_DAYS, selectStalePrices } from "./prices";

export type { FireScopeConfig, FireResult } from "./fire";
export { filterFireEligibleAssets, calculateFire, calculateFireForScope } from "./fire";

export type { WarningSeverity, DomainWarning, WarningOverride } from "./warnings";
export { collectWarnings } from "./warnings";
import { collectWarnings } from "./warnings";
import type { DomainWarning } from "./warnings";

export type { ScopeType, ScopeOption } from "./scope";
export { listScopeOptions, resolveScopeMemberIds } from "./scope";
import { resolveScopeMemberIds } from "./scope";

export { allocateOwnedMoneyMinor } from "./ownership";

export type { ScopedHolding } from "./scope-allocation";
export { allocateScopedHolding } from "./scope-allocation";
import { allocateScopedHolding } from "./scope-allocation";

export type {
  PortfolioProjection,
  PortfolioProjectionInput,
  PortfolioSection,
  AssetsSection,
  LiabilitiesSection,
  ProjectedAssetRow,
  ProjectedLiabilityRow,
  RowOwnership,
} from "./portfolio-projection";
export { projectPortfolio } from "./portfolio-projection";

export type { DecimalString } from "./decimal";

export type { DashboardState, LocalPersistenceStatus, OnboardingStep } from "./dashboard";
export {
  deriveOnboardingProgress,
  largestRemainderPercentages,
  prepareDashboardState,
  signedDeltaBarWidths,
} from "./dashboard";

export type { CaptureDecision, SnapshotPolicyEntry } from "./snapshot-policy";
export { deriveMonthlyCloses, planSnapshotCapture } from "./snapshot-policy";

/**
 * A rule violation reported by a domain constructor — carries a stable
 * machine-readable `code` plus context fields that callers can use to format
 * a user-facing message without re-deriving the rule.
 *
 * Discriminated by `code` so callers can switch on it exhaustively.
 */
export type DomainViolation =
  | { code: "ownership_split_invalid"; totalBps: number }
  | { code: "operation_units_not_positive" }
  | { code: "operation_price_negative" }
  | { code: "operation_fees_negative" }
  | { code: "investment_manual_valuation_rejected" }
  | { code: "value_update_investment_holding" };

/**
 * Discriminated result returned by safe domain constructors.
 * `{ ok: true, value }` carries the created entity.
 * `{ ok: false, violations }` carries a non-empty list of violations with
 * stable machine-readable codes — no exception is thrown.
 *
 * Programmer-error paths (unknown member id, non-integer bps, invalid
 * currency) still throw — only rule violations become data.
 */
export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: [DomainViolation, ...DomainViolation[]] };

export type WorkspaceMode = "individual" | "household";

export interface Member {
  id: string;
  name: string;
  disabledAt?: string;
}

export interface MemberGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface Workspace {
  baseCurrency: CurrencyCode;
  mode: WorkspaceMode;
  members: Member[];
  groups: MemberGroup[];
}

export function createWorkspace(input: {
  mode: WorkspaceMode;
  members: Member[];
  groups?: MemberGroup[];
  baseCurrency?: CurrencyCode;
}): Workspace {
  if (input.members.length === 0) {
    throw new Error("Workspace requires at least one member.");
  }

  const activeMemberIds = new Set(
    input.members.filter((member) => !member.disabledAt).map((member) => member.id),
  );

  for (const group of input.groups ?? []) {
    for (const memberId of group.memberIds) {
      if (!activeMemberIds.has(memberId)) {
        throw new Error(`Group ${group.id} references unknown member ${memberId}.`);
      }
    }
  }

  return {
    baseCurrency: input.baseCurrency ?? "EUR",
    groups: input.groups ?? [],
    members: input.members,
    mode: input.mode,
  };
}

export type AssetType = "cash" | "manual" | "real_estate" | "investment";

export interface OwnershipShare {
  memberId: string;
  shareBps: number;
}

export interface ManualAsset {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValue: MoneyMinor;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  isPrimaryResidence: boolean;
}

export type LiabilityType = "mortgage" | "debt";

export interface Liability {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  currentBalance: MoneyMinor;
  ownership: OwnershipShare[];
  associatedAssetId?: string;
}

export interface CreateManualAssetInput {
  id: string;
  name: string;
  type: AssetType;
  currency: CurrencyCode;
  currentValueMinor: number;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  isPrimaryResidence?: boolean;
}

export interface CreateLiabilityInput {
  id: string;
  name: string;
  type: LiabilityType;
  currency: CurrencyCode;
  balanceMinor: number;
  ownership: OwnershipShare[];
  associatedAssetId?: string;
}

export type OperationKind = "buy" | "sell";

/** A single buy or sell against a unit-based (investment) asset. */
export interface InvestmentOperation {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor: number;
}

export interface CreateInvestmentOperationInput {
  id: string;
  assetId: string;
  kind: OperationKind;
  executedAt: string;
  units: DecimalString;
  pricePerUnit: DecimalString;
  currency: CurrencyCode;
  feesMinor?: number;
}

/** Derived state of a unit-based asset after folding its operations. */
export interface PositionSummary {
  assetId: string;
  currency: CurrencyCode;
  currentUnits: DecimalString;
  costBasis: MoneyMinor;
  averageUnitCost: DecimalString;
  marketValue?: MoneyMinor;
  unrealizedPnl?: MoneyMinor;
  warnings: string[];
}

export interface NetWorthSummary {
  scopeId: string;
  totalNetWorth: MoneyMinor;
  liquidNetWorth: MoneyMinor;
  housingEquity: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
}

/**
 * Which figure headlines the dashboard. A framing re-labels the hero number; it
 * never introduces a new figure (see ADR 0003). "total" = net worth (everything),
 * "liquid" = liquid net worth (cash + market tiers).
 */
export type NetWorthFraming = "total" | "liquid";

export type NetWorthBreakdownId =
  | "liquid-net-worth"
  | "housing-equity"
  | "gross-assets"
  | "debts";

export interface NetWorthBreakdownItem {
  id: NetWorthBreakdownId;
  label: string;
  value: MoneyMinor;
}

/**
 * The headline figure for the chosen framing plus the always-visible breakdown.
 * The breakdown is a fixed set, identical across framings — the framing only
 * decides which figure is the hero.
 */
export interface NetWorthPresentation {
  framing: NetWorthFraming;
  headlineLabel: string;
  headline: MoneyMinor;
  breakdown: NetWorthBreakdownItem[];
}

export interface NetWorthSnapshot {
  id: string;
  scopeId: string;
  scopeLabel: string;
  capturedAt: string;
  dateKey: string;
  monthKey: string;
  isMonthlyClose: boolean;
  totalNetWorth: MoneyMinor;
  liquidNetWorth: MoneyMinor;
  housingEquity: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
  warnings: DomainWarning[];
}

export interface CreateNetWorthSnapshotInput {
  id: string;
  scopeId: string;
  scopeLabel: string;
  capturedAt: string;
  summary: NetWorthSummary;
  isMonthlyClose?: boolean;
  warnings?: DomainWarning[];
}

export interface SnapshotDeltas {
  snapshot: NetWorthSnapshot;
  previousSnapshot?: NetWorthSnapshot;
  previousMonthlyClose?: NetWorthSnapshot;
  changeSincePrevious?: MoneyMinor;
  changeSinceMonthlyClose?: MoneyMinor;
}

export interface LiquidityComponent {
  id: string;
  name: string;
  valueMinor: number;
}

export interface LiquidityTierBreakdown {
  tier: LiquidityTier;
  netValue: MoneyMinor;
  grossAssets: MoneyMinor;
  debts: MoneyMinor;
  /** This tier's share of the scope's total gross assets, in basis points. */
  shareOfGrossBps: number;
  assets: LiquidityComponent[];
  liabilities: LiquidityComponent[];
}

export const defaultLiquidityTierOrder = [
  "housing",
  "illiquid",
  "retirement",
  "market",
  "cash",
] as const satisfies readonly LiquidityTier[];

export function createManualAsset(
  workspace: Workspace,
  input: CreateManualAssetInput,
): ManualAsset {
  assertCurrency(input.currency);
  assertMinorInteger(input.currentValueMinor);
  assertOwnership(workspace, input.ownership);

  return {
    currency: input.currency,
    currentValue: {
      amountMinor: input.currentValueMinor,
      currency: input.currency,
    },
    id: input.id,
    isPrimaryResidence: input.isPrimaryResidence ?? false,
    liquidityTier: input.liquidityTier,
    name: input.name,
    ownership: input.ownership,
    type: input.type,
  };
}

export function createLiability(
  workspace: Workspace,
  input: CreateLiabilityInput,
): Liability {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);
  assertOwnership(workspace, input.ownership);

  return {
    currency: input.currency,
    currentBalance: {
      amountMinor: input.balanceMinor,
      currency: input.currency,
    },
    id: input.id,
    name: input.name,
    ownership: input.ownership,
    type: input.type,
    ...(input.associatedAssetId ? { associatedAssetId: input.associatedAssetId } : {}),
  };
}

/**
 * Safe variant of `createManualAsset`: returns a `DomainResult` instead of
 * throwing when the ownership split does not total 10 000 bps.
 * Programmer-error paths (unknown member, non-integer bps, bad currency) still
 * throw — only the ownership-split rule becomes data.
 */
export function createManualAssetSafe(
  workspace: Workspace,
  input: CreateManualAssetInput,
): DomainResult<ManualAsset> {
  assertCurrency(input.currency);
  assertMinorInteger(input.currentValueMinor);

  const splitViolation = checkOwnershipSplit(workspace, input.ownership);

  if (splitViolation) {
    return { ok: false, violations: [splitViolation] };
  }

  return { ok: true, value: createManualAsset(workspace, input) };
}

/**
 * Safe variant of `createLiability`: returns a `DomainResult` instead of
 * throwing when the ownership split does not total 10 000 bps.
 */
export function createLiabilitySafe(
  workspace: Workspace,
  input: CreateLiabilityInput,
): DomainResult<Liability> {
  assertCurrency(input.currency);
  assertMinorInteger(input.balanceMinor);

  const splitViolation = checkOwnershipSplit(workspace, input.ownership);

  if (splitViolation) {
    return { ok: false, violations: [splitViolation] };
  }

  return { ok: true, value: createLiability(workspace, input) };
}

export function calculateNetWorth(input: {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
}): NetWorthSummary {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const currency = input.workspace.baseCurrency;
  const zero = money(0, currency);
  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );

  let grossAssets = zero;
  let liquidAssets = zero;
  let housingAssets = zero;
  let debts = zero;
  let housingDebts = zero;
  let liquidDebts = zero;

  for (const asset of input.assets) {
    const scoped = money(
      allocateScopedHolding(asset.currentValue.amountMinor, {
        ownership: asset.ownership,
        scopeMemberIds,
      }).ownedMinor,
      currency,
    );

    grossAssets = addMoney(grossAssets, scoped);

    if (isHousingAsset(asset)) {
      housingAssets = addMoney(housingAssets, scoped);
    }

    if (isLiquid(tierOfAsset(asset))) {
      liquidAssets = addMoney(liquidAssets, scoped);
    }
  }

  for (const liability of input.liabilities ?? []) {
    const scoped = money(
      allocateScopedHolding(liability.currentBalance.amountMinor, {
        ownership: liability.ownership,
        scopeMemberIds,
      }).ownedMinor,
      currency,
    );

    debts = addMoney(debts, scoped);

    const tier = tierOfLiability(liability, assetTierById);

    if (isHousing(tier)) {
      housingDebts = addMoney(housingDebts, scoped);
    } else if (isLiquid(tier)) {
      liquidDebts = addMoney(liquidDebts, scoped);
    }
  }

  return {
    debts,
    grossAssets,
    housingEquity: subtractMoney(housingAssets, housingDebts),
    liquidNetWorth: subtractMoney(liquidAssets, liquidDebts),
    scopeId: input.scopeId,
    totalNetWorth: subtractMoney(grossAssets, debts),
  };
}

export function presentNetWorth(
  summary: NetWorthSummary,
  framing: NetWorthFraming,
): NetWorthPresentation {
  const breakdown: NetWorthBreakdownItem[] = [
    { id: "liquid-net-worth", label: "Neto liquido", value: summary.liquidNetWorth },
    { id: "housing-equity", label: "Vivienda neta", value: summary.housingEquity },
    { id: "gross-assets", label: "Activos brutos", value: summary.grossAssets },
    { id: "debts", label: "Deudas", value: summary.debts },
  ];

  return {
    breakdown,
    framing,
    headline: framing === "liquid" ? summary.liquidNetWorth : summary.totalNetWorth,
    headlineLabel: framing === "liquid" ? "Neto liquido" : "Neto total",
  };
}

export function createNetWorthSnapshot(
  input: CreateNetWorthSnapshotInput,
): NetWorthSnapshot {
  const capturedAt = new Date(input.capturedAt);

  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error("Snapshot capturedAt must be a valid date.");
  }

  const dateKey = input.capturedAt.slice(0, 10);
  const monthKey = dateKey.slice(0, 7);

  return {
    capturedAt: input.capturedAt,
    dateKey,
    debts: { ...input.summary.debts },
    grossAssets: { ...input.summary.grossAssets },
    housingEquity: { ...input.summary.housingEquity },
    id: input.id,
    isMonthlyClose: input.isMonthlyClose ?? false,
    liquidNetWorth: { ...input.summary.liquidNetWorth },
    monthKey,
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    totalNetWorth: { ...input.summary.totalNetWorth },
    warnings: input.warnings ?? [],
  };
}

export function captureNetWorthSnapshot(input: {
  workspace: Workspace;
  scopeId: string;
  scopeLabel: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
  capturedAt: string;
  id: string;
  isMonthlyClose?: boolean;
}): NetWorthSnapshot {
  const summary = calculateNetWorth({
    workspace: input.workspace,
    scopeId: input.scopeId,
    assets: input.assets,
    ...(input.liabilities ? { liabilities: input.liabilities } : {}),
  });
  const warnings = collectWarnings(input.assets);

  return createNetWorthSnapshot({
    capturedAt: input.capturedAt,
    id: input.id,
    ...(input.isMonthlyClose ? { isMonthlyClose: input.isMonthlyClose } : {}),
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    summary,
    warnings,
  });
}

export function calculateSnapshotDeltas(
  snapshots: NetWorthSnapshot[],
  snapshotId: string,
): SnapshotDeltas {
  const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);

  if (!snapshot) {
    throw new Error(`Unknown snapshot ${snapshotId}.`);
  }

  const scopedSnapshots = snapshots
    .filter((candidate) => candidate.scopeId === snapshot.scopeId)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const index = scopedSnapshots.findIndex((candidate) => candidate.id === snapshot.id);
  const previousSnapshot = index > 0 ? scopedSnapshots[index - 1] : undefined;

  // Monthly closes are derived — the last snapshot of each calendar month wins.
  // The reference close for delta is the most recent close from a prior month
  // (different from the current snapshot's month).
  const priorMonthSnapshots = scopedSnapshots
    .slice(0, index)
    .filter((candidate) => candidate.monthKey < snapshot.monthKey);
  const monthlyCloseIds = deriveMonthlyCloses(priorMonthSnapshots);
  const closedMonthIds = new Set(monthlyCloseIds.values());
  const previousMonthlyClose = priorMonthSnapshots
    .slice()
    .reverse()
    .find((candidate) => closedMonthIds.has(candidate.id));

  return {
    snapshot,
    ...(previousSnapshot
      ? {
          changeSincePrevious: subtractMoney(
            snapshot.totalNetWorth,
            previousSnapshot.totalNetWorth,
          ),
          previousSnapshot,
        }
      : {}),
    ...(previousMonthlyClose
      ? {
          changeSinceMonthlyClose: subtractMoney(
            snapshot.totalNetWorth,
            previousMonthlyClose.totalNetWorth,
          ),
          previousMonthlyClose,
        }
      : {}),
  };
}

export function buildLiquidityBreakdown(input: {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
}): LiquidityTierBreakdown[] {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const currency = input.workspace.baseCurrency;
  const tiers = new Map<LiquidityTier, LiquidityTierBreakdown>();

  for (const tier of defaultLiquidityTierOrder) {
    tiers.set(tier, {
      assets: [],
      debts: money(0, currency),
      grossAssets: money(0, currency),
      liabilities: [],
      netValue: money(0, currency),
      shareOfGrossBps: 0,
      tier,
    });
  }

  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );

  for (const asset of input.assets) {
    const breakdown = tiers.get(tierOfAsset(asset));

    if (!breakdown) {
      continue;
    }

    const scopedValue = allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;
    const scoped = money(scopedValue, currency);

    breakdown.grossAssets = addMoney(breakdown.grossAssets, scoped);
    breakdown.netValue = addMoney(breakdown.netValue, scoped);

    if (scopedValue !== 0) {
      breakdown.assets.push({
        id: asset.id,
        name: asset.name,
        valueMinor: scopedValue,
      });
    }
  }

  for (const liability of input.liabilities ?? []) {
    const tier = tierOfLiability(liability, assetTierById);
    const breakdown = tiers.get(tier);

    if (!breakdown) {
      continue;
    }

    const scopedValue = allocateScopedHolding(liability.currentBalance.amountMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    }).ownedMinor;
    const scoped = money(scopedValue, currency);

    breakdown.debts = addMoney(breakdown.debts, scoped);
    breakdown.netValue = subtractMoney(breakdown.netValue, scoped);

    if (scopedValue !== 0) {
      breakdown.liabilities.push({
        id: liability.id,
        name: liability.name,
        valueMinor: scopedValue,
      });
    }
  }

  const totalGross = defaultLiquidityTierOrder.reduce(
    (sum, tier) => sum + tiers.get(tier)!.grossAssets.amountMinor,
    0,
  );

  for (const tier of defaultLiquidityTierOrder) {
    const breakdown = tiers.get(tier)!;
    breakdown.shareOfGrossBps =
      totalGross > 0
        ? Math.round((breakdown.grossAssets.amountMinor / totalGross) * 10_000)
        : 0;
  }

  // Ordered most→least liquid (cash at the top), so the breakdown reads as a
  // liquidity ladder ending in the illiquid housing tier.
  const liquidFirstOrder: LiquidityTier[] = [
    "cash",
    "market",
    "retirement",
    "illiquid",
    "housing",
  ];

  return liquidFirstOrder.map((tier) => tiers.get(tier)!);
}

function assertCurrency(currency: CurrencyCode): void {
  if (!currency.trim()) {
    throw new Error("Currency is required.");
  }
}

/**
 * Checks the ownership split for the "totals 10 000 bps" rule.
 * Returns a `DomainViolation` when the split is invalid, `null` when valid.
 * Programmer errors (unknown member, non-integer bps) still throw.
 */
function checkOwnershipSplit(
  workspace: Workspace,
  ownership: OwnershipShare[],
): Extract<DomainViolation, { code: "ownership_split_invalid" }> | null {
  const knownMemberIds = new Set(workspace.members.map((member) => member.id));
  const totalBps = ownership.reduce((sum, share) => {
    if (!knownMemberIds.has(share.memberId)) {
      throw new Error(`Ownership references unknown member ${share.memberId}.`);
    }

    if (!Number.isInteger(share.shareBps) || share.shareBps <= 0) {
      throw new Error("Ownership share must be a positive integer bps value.");
    }

    return sum + share.shareBps;
  }, 0);

  if (totalBps !== 10_000) {
    return { code: "ownership_split_invalid", totalBps };
  }

  return null;
}

function assertOwnership(workspace: Workspace, ownership: OwnershipShare[]): void {
  const violation = checkOwnershipSplit(workspace, ownership);

  if (violation) {
    throw new Error("Ownership shares must add up to 10000 bps.");
  }
}

export interface DashboardShell {
  productName: "worthline";
  baseCurrency: "EUR";
  generatedAt: string;
  persistence: LocalPersistenceStatus;
}

export function createDashboardShell(input: {
  persistence: LocalPersistenceStatus;
  summary?: NetWorthSummary;
  moduleStates?: Partial<Record<string, "empty" | "ready">>;
}): DashboardShell {
  return {
    productName: "worthline",
    baseCurrency: "EUR",
    generatedAt: input.persistence.checkedAt,
    persistence: input.persistence,
  };
}
