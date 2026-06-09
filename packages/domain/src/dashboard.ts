import type { AssetPrice } from "./prices";

export interface LocalPersistenceStatus {
  status: "ok";
  databasePath: string;
  displayPath: string;
  checkedAt: string;
  checkKey: string;
  checkValue: string;
}
import type {
  FireScopeConfig,
  Liability,
  ManualAsset,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSummary,
  PositionSummary,
  ScopeOption,
  SnapshotDeltas,
  WarningOverride,
  Workspace,
} from "./index";
import type { LiquidityTierBreakdown } from "./index";
import type { DashboardShell, DomainWarning } from "./index";
import {
  buildLiquidityBreakdown,
  calculateFireForScope,
  calculateNetWorth,
  calculateSnapshotDeltas,
  collectWarnings,
  createDashboardShell,
  presentNetWorth,
  resolveScopeMemberIds,
} from "./index";

export interface PositionView extends PositionSummary {
  name: string;
}

export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
}

/**
 * The ordered "first steps" a new workspace should complete, each marked done
 * from the current counts. Pure — drives the first-run checklist and the
 * empty-state guidance.
 */
export function deriveOnboardingProgress(input: {
  activeMemberCount: number;
  holdingCount: number;
  positionCount: number;
  hasFireConfig: boolean;
  snapshotCount: number;
}): OnboardingStep[] {
  return [
    { id: "members", label: "Revisa los miembros", done: input.activeMemberCount > 0 },
    {
      id: "holdings",
      label: "Añade tu primer activo o deuda",
      done: input.holdingCount > 0,
    },
    { id: "investments", label: "Registra una inversión", done: input.positionCount > 0 },
    { id: "fire", label: "Configura FIRE", done: input.hasFireConfig },
    { id: "snapshot", label: "Guarda tu primer snapshot", done: input.snapshotCount > 0 },
  ];
}

export interface DashboardState {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: import("./index").NetWorthSnapshot[];
  summary: NetWorthSummary | undefined;
  presentation: NetWorthPresentation | undefined;
  fireScopeConfig: FireScopeConfig | null;
  fireResult: ReturnType<typeof calculateFireForScope> | null;
  selectedMemberIds: string[];
  pyramid: LiquidityTierBreakdown[];
  deltas: SnapshotDeltas | undefined;
  dashboard: DashboardShell;
  activeMembers: import("./index").Member[];
  investmentAssets: ManualAsset[];
  today: string;
  warnings: DomainWarning[];
  onboarding: OnboardingStep[];
  selectedView: NetWorthFraming;
}

export function prepareDashboardState(input: {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: import("./index").NetWorthSnapshot[];
  fireConfig: Record<string, FireScopeConfig>;
  selectedView: NetWorthFraming;
  overrides?: WarningOverride[];
}): DashboardState {
  const { workspace, assets, liabilities, selectedScope, persistence } = input;

  const summary =
    workspace && selectedScope
      ? calculateNetWorth({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : undefined;

  const presentation = summary ? presentNetWorth(summary, input.selectedView) : undefined;

  const fireScopeConfig: FireScopeConfig | null = selectedScope
    ? (input.fireConfig[selectedScope.id] ?? null)
    : null;

  const fireResult =
    fireScopeConfig && workspace && selectedScope
      ? calculateFireForScope(fireScopeConfig, assets, workspace, selectedScope.id)
      : null;

  const selectedMemberIds =
    workspace && selectedScope ? resolveScopeMemberIds(workspace, selectedScope.id) : [];

  const pyramid =
    workspace && selectedScope
      ? buildLiquidityBreakdown({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : [];

  const latestSnapshot = input.snapshots.at(-1);
  const deltas = latestSnapshot
    ? calculateSnapshotDeltas(input.snapshots, latestSnapshot.id)
    : undefined;

  const dashboard = createDashboardShell({
    moduleStates: {
      liquidity: workspace ? "ready" : "empty",
      members: workspace ? "ready" : "empty",
      ownership: assets.length > 0 || liabilities.length > 0 ? "ready" : "empty",
      snapshots: input.snapshots.length > 0 ? "ready" : "empty",
    },
    persistence,
    ...(summary ? { summary } : {}),
  });

  const activeMembers = workspace?.members.filter((member) => !member.disabledAt) ?? [];
  const investmentAssets = assets.filter((asset) => asset.type === "investment");
  const today = new Date().toISOString().slice(0, 10);
  const warnings = collectWarnings(assets, input.overrides ?? []);
  const onboarding = deriveOnboardingProgress({
    activeMemberCount: activeMembers.length,
    holdingCount: assets.length + liabilities.length,
    positionCount: input.positions.length,
    hasFireConfig: fireScopeConfig !== null,
    snapshotCount: input.snapshots.length,
  });

  return {
    activeMembers,
    assets,
    dashboard,
    deltas,
    fireResult,
    fireScopeConfig,
    investmentAssets,
    liabilities,
    onboarding,
    persistence,
    positions: input.positions,
    presentation,
    priceCache: input.priceCache,
    pyramid,
    scopes: input.scopes,
    selectedMemberIds,
    selectedScope,
    selectedView: input.selectedView,
    snapshots: input.snapshots,
    summary,
    today,
    warnings,
    workspace,
  };
}
