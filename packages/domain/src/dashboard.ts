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
  const warnings = collectWarnings(assets);

  return {
    activeMembers,
    assets,
    dashboard,
    deltas,
    fireResult,
    fireScopeConfig,
    investmentAssets,
    liabilities,
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
