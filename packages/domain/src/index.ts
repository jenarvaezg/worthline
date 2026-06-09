import type {
  CurrencyCode,
  DecimalString,
  LocalPersistenceStatus,
  LiquidityTier,
  MoneyMinor,
} from "@worthline/contracts";

import {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  money,
  subtractMoney,
} from "./money";

export {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  money,
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

export {
  isHousing,
  isHousingAsset,
  isLiquid,
  tierOfAsset,
  tierOfLiability,
} from "./classification";

export { createInvestmentOperation, derivePosition } from "./positions";

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

export type ScopeType = "household" | "member" | "group";

export interface ScopeOption {
  id: string;
  label: string;
  type: ScopeType;
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

export function listScopeOptions(workspace: Workspace): ScopeOption[] {
  const members = workspace.members.filter((member) => !member.disabledAt);

  return [
    { id: "household", label: "Hogar", type: "household" },
    ...members.map((member) => ({
      id: member.id,
      label: member.name,
      type: "member" as const,
    })),
    ...workspace.groups.map((group) => ({
      id: group.id,
      label: group.name,
      type: "group" as const,
    })),
  ];
}

export function resolveScopeMemberIds(workspace: Workspace, scopeId: string): string[] {
  if (scopeId === "household") {
    return workspace.members
      .filter((member) => !member.disabledAt)
      .map((member) => member.id);
  }

  const member = workspace.members.find(
    (candidate) => candidate.id === scopeId && !candidate.disabledAt,
  );

  if (member) {
    return [member.id];
  }

  const group = workspace.groups.find((candidate) => candidate.id === scopeId);

  if (group) {
    return group.memberIds.filter((memberId) =>
      workspace.members.some(
        (candidate) => candidate.id === memberId && !candidate.disabledAt,
      ),
    );
  }

  throw new Error(`Unknown scope ${scopeId}.`);
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

export type NetWorthPresentationMode = "liquid" | "housing-inclusive" | "gross-debt";

export type NetWorthPresentation =
  | {
      mode: "liquid" | "housing-inclusive";
      label: string;
      primary: MoneyMinor;
    }
  | {
      mode: "gross-debt";
      label: string;
      primary: MoneyMinor;
      gross: MoneyMinor;
      debt: MoneyMinor;
    };

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
  warnings: string[];
}

export interface CreateNetWorthSnapshotInput {
  id: string;
  scopeId: string;
  scopeLabel: string;
  capturedAt: string;
  summary: NetWorthSummary;
  isMonthlyClose?: boolean;
  warnings?: string[];
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
      allocateOwnedMoneyMinor(asset.currentValue.amountMinor, {
        ownership: asset.ownership,
        scopeMemberIds,
      }),
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
      allocateOwnedMoneyMinor(liability.currentBalance.amountMinor, {
        ownership: liability.ownership,
        scopeMemberIds,
      }),
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
  mode: NetWorthPresentationMode,
): NetWorthPresentation {
  if (mode === "liquid") {
    return {
      label: "Neto liquido",
      mode,
      primary: summary.liquidNetWorth,
    };
  }

  if (mode === "housing-inclusive") {
    return {
      label: "Neto con vivienda",
      mode,
      primary: summary.totalNetWorth,
    };
  }

  return {
    debt: summary.debts,
    gross: summary.grossAssets,
    label: "Activos brutos y deudas",
    mode,
    primary: summary.totalNetWorth,
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
  const previousMonthlyClose = scopedSnapshots
    .slice(0, index)
    .reverse()
    .find((candidate) => candidate.isMonthlyClose);

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

export function buildLiquidityPyramid(input: {
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

    const scopedValue = allocateOwnedMoneyMinor(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    });
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

    const scopedValue = allocateOwnedMoneyMinor(liability.currentBalance.amountMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    });
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

  return defaultLiquidityTierOrder.map((tier) => tiers.get(tier)!);
}

function assertCurrency(currency: CurrencyCode): void {
  if (!currency.trim()) {
    throw new Error("Currency is required.");
  }
}

function assertOwnership(workspace: Workspace, ownership: OwnershipShare[]): void {
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
    throw new Error("Ownership shares must add up to 10000 bps.");
  }
}

function allocateOwnedMoneyMinor(
  amountMinor: number,
  input: {
    ownership: OwnershipShare[];
    scopeMemberIds: Set<string>;
  },
): number {
  const shareBps = input.ownership
    .filter((share) => input.scopeMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);

  return allocateByBps(amountMinor, shareBps);
}

export type DashboardMetricId =
  | "total-net-worth"
  | "liquid-net-worth"
  | "housing-equity"
  | "gross-assets"
  | "debts";

export interface DashboardMetric {
  id: DashboardMetricId;
  label: string;
  value: MoneyMinor;
  posture: "neutral" | "asset" | "liability";
}

export interface DashboardModule {
  id: string;
  label: string;
  state: "empty" | "ready";
}

export interface DashboardShell {
  productName: "worthline";
  baseCurrency: "EUR";
  generatedAt: string;
  persistence: LocalPersistenceStatus;
  metrics: DashboardMetric[];
  modules: DashboardModule[];
}

export function createDashboardShell(input: {
  persistence: LocalPersistenceStatus;
  summary?: NetWorthSummary;
  moduleStates?: Partial<Record<DashboardModule["id"], DashboardModule["state"]>>;
}): DashboardShell {
  const summary = input.summary;

  return {
    productName: "worthline",
    baseCurrency: "EUR",
    generatedAt: input.persistence.checkedAt,
    persistence: input.persistence,
    metrics: [
      metric("total-net-worth", "Neto total", "neutral", summary?.totalNetWorth),
      metric("liquid-net-worth", "Neto liquido", "asset", summary?.liquidNetWorth),
      metric("housing-equity", "Vivienda neta", "asset", summary?.housingEquity),
      metric("gross-assets", "Activos brutos", "asset", summary?.grossAssets),
      metric("debts", "Deudas", "liability", summary?.debts),
    ],
    modules: [
      module("members", "Miembros", input.moduleStates),
      module("ownership", "Ownership", input.moduleStates),
      module("liquidity", "Piramide de liquidez", input.moduleStates),
      module("snapshots", "Snapshots", input.moduleStates),
      module("fire", "FIRE", input.moduleStates),
    ],
  };
}

function metric(
  id: DashboardMetricId,
  label: string,
  posture: DashboardMetric["posture"],
  value?: MoneyMinor,
): DashboardMetric {
  return {
    id,
    label,
    posture,
    value: value ?? {
      amountMinor: 0,
      currency: "EUR",
    },
  };
}

function module(
  id: DashboardModule["id"],
  label: string,
  states?: Partial<Record<DashboardModule["id"], DashboardModule["state"]>>,
): DashboardModule {
  return {
    id,
    label,
    state: states?.[id] ?? "empty",
  };
}
