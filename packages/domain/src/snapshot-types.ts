import type { DecimalString } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import type { MoneyMinor } from "./money";
import { subtractMoney } from "./money";
import type { NetWorthFraming, NetWorthSummary } from "./net-worth";
import { calculateNetWorth } from "./net-worth";
import type {
  InvestmentCaptureDetail,
  SnapshotHoldingRow,
  SnapshotPositionInput,
} from "./snapshot-holdings";
import {
  assertSnapshotHoldingsReconcile,
  buildSnapshotHoldingRows,
} from "./snapshot-holdings";
import { deriveMonthlyCloses } from "./snapshot-policy";
import type { DomainWarning, WarningOverride } from "./warnings";
import { collectWarnings } from "./warnings";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

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

/**
 * What a capture needs to freeze the SAME warnings the app shows live (#1364).
 *
 * `warnings_json` is history: whatever it records is what a future trend view or
 * export will read. Without these two the capture wrote avisos the live engine
 * already filters — a closed position's missing symbol, and a warning the user
 * had explicitly acknowledged — so the salud-de-datos panel and the persisted row
 * disagreed about the same fact, and the one on disk was the wrong one.
 *
 * Both optional, and each answers the question AS OF the snapshot's own date: the
 * daily capture passes today's ledger, the historical backfill passes the units
 * held on the date it is reconstructing. A caller with no ledger in hand
 * (fixtures) keeps the previous reading, where an absent entry means "open".
 */
export interface SnapshotWarningInputs {
  /** Net units still held per holding (`netUnitsByAsset`); absent = open (#1348). */
  netUnitsByAssetId?: ReadonlyMap<string, DecimalString>;
  /**
   * The investment ledger keyed by holding id (#1443). Absent = do not look at
   * the book, matching {@link CollectWarningsOptions.operationsByAssetId}. The
   * daily capture already holds this map; historical reconstruction may not.
   */
  operationsByAssetId?: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /**
   * Acknowledgements that an overrideable warning is intentional. Overrides are
   * not dated, so only the live capture path supplies them — the historical
   * backfill would apply today's acknowledgements to a past date.
   */
  warningOverrides?: WarningOverride[];
}

export function captureNetWorthSnapshot(
  input: {
    workspace: Workspace;
    scopeId: string;
    scopeLabel: string;
    assets: ManualAsset[];
    liabilities?: Liability[];
    /** The asset set a debt is classified against (#1436) — see calculateNetWorth. */
    classificationAssets?: ManualAsset[];
    capturedAt: string;
    id: string;
    isMonthlyClose?: boolean;
  } & SnapshotWarningInputs,
): NetWorthSnapshot {
  const summary = calculateNetWorth({
    workspace: input.workspace,
    scopeId: input.scopeId,
    assets: input.assets,
    ...(input.classificationAssets
      ? { classificationAssets: input.classificationAssets }
      : {}),
    ...(input.liabilities ? { liabilities: input.liabilities } : {}),
  });
  const warnings = collectWarnings(input.assets, input.warningOverrides ?? [], {
    ...(input.netUnitsByAssetId ? { netUnitsByAssetId: input.netUnitsByAssetId } : {}),
    ...(input.operationsByAssetId
      ? { operationsByAssetId: input.operationsByAssetId }
      : {}),
  });

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

/** A snapshot plus the valued portfolio behind its figures (ADR 0008). */
export interface ValuedNetWorthSnapshot {
  snapshot: NetWorthSnapshot;
  holdings: SnapshotHoldingRow[];
}

/**
 * Capture a snapshot together with its holding rows (ADR 0008).
 *
 * Produces the same five headline figures as `captureNetWorthSnapshot` plus one
 * frozen row per holding behind them, scope-weighted identically. Enforces the
 * reconciliation invariant before returning: if the rows do not sum exactly to
 * the headline gross assets and debts, the capture fails loudly so nothing
 * partial can be persisted.
 */
export function captureValuedNetWorthSnapshot(
  input: {
    workspace: Workspace;
    scopeId: string;
    scopeLabel: string;
    assets: ManualAsset[];
    liabilities?: Liability[];
    /** The asset set a debt is classified against (#1436) — see calculateNetWorth. */
    classificationAssets?: ManualAsset[];
    capturedAt: string;
    id: string;
    isMonthlyClose?: boolean;
    /** Per-investment units and unit price, keyed by asset id. */
    investmentDetails?: ReadonlyMap<string, InvestmentCaptureDetail>;
    /** Per-connected-source position breakdown, keyed by asset id (ADR 0035). */
    positionDetails?: ReadonlyMap<string, SnapshotPositionInput[]>;
  } & SnapshotWarningInputs,
): ValuedNetWorthSnapshot {
  const snapshot = captureNetWorthSnapshot(input);
  const holdings = buildSnapshotHoldingRows({
    assets: input.assets,
    scopeId: input.scopeId,
    workspace: input.workspace,
    ...(input.classificationAssets
      ? { classificationAssets: input.classificationAssets }
      : {}),
    ...(input.liabilities ? { liabilities: input.liabilities } : {}),
    ...(input.investmentDetails ? { investmentDetails: input.investmentDetails } : {}),
    ...(input.positionDetails ? { positionDetails: input.positionDetails } : {}),
  });

  assertSnapshotHoldingsReconcile(holdings, {
    debtsMinor: snapshot.debts.amountMinor,
    grossAssetsMinor: snapshot.grossAssets.amountMinor,
  });

  return { holdings, snapshot };
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

/** A headline change in the active framing: the amount plus its percent. */
export interface FramedDelta {
  change: MoneyMinor;
  /** Percent vs the base snapshot's framed value; `null` when that base is zero. */
  pct: number | null;
}

/** The two headline change chips, each in the active framing or `null`. */
export interface FramedSnapshotDeltas {
  /** Change vs the immediately previous snapshot. */
  sincePrevious: FramedDelta | null;
  /** Change vs the most recent prior-month close. */
  sinceMonthlyClose: FramedDelta | null;
}

/** The headline figure of a snapshot under the active framing. */
function framedSnapshotValueMinor(
  snapshot: NetWorthSnapshot,
  framing: NetWorthFraming,
): number {
  return framing === "liquid"
    ? snapshot.liquidNetWorth.amountMinor
    : snapshot.totalNetWorth.amountMinor;
}

function framedDelta(
  current: NetWorthSnapshot,
  base: NetWorthSnapshot | undefined,
  framing: NetWorthFraming,
): FramedDelta | null {
  if (!base) return null;

  const currentMinor = framedSnapshotValueMinor(current, framing);
  const baseMinor = framedSnapshotValueMinor(base, framing);

  return {
    change: {
      amountMinor: currentMinor - baseMinor,
      currency: current.totalNetWorth.currency,
    },
    pct:
      baseMinor === 0 ? null : ((currentMinor - baseMinor) / Math.abs(baseMinor)) * 100,
  };
}

/**
 * The two headline change chips the dashboard renders, computed in the active
 * framing (#244). Pure figure math over the snapshots the deltas already carry:
 * it re-frames the change from `total` (the raw delta figure) to the chosen
 * framing's headline value, so a mobile client reading the same contract gets
 * the figures that reach the screen without re-deriving them.
 */
export function deriveFramedSnapshotDeltas(
  deltas: SnapshotDeltas,
  framing: NetWorthFraming,
): FramedSnapshotDeltas {
  return {
    sinceMonthlyClose: framedDelta(deltas.snapshot, deltas.previousMonthlyClose, framing),
    sincePrevious: framedDelta(deltas.snapshot, deltas.previousSnapshot, framing),
  };
}
