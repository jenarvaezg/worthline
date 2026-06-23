import type { WorthlineStore } from "@worthline/db";
import type {
  CompositionRange,
  CompositionSeriesPoint,
  DatedSnapshotHoldingRow,
  DrilldownKey,
  DrilldownState,
} from "@worthline/domain";
import {
  buildCompositionSeries,
  buildDrilldown,
  rangeStartMonthKey,
} from "@worthline/domain";

import { cellKey, type MatrixCoord } from "./dashboard-matrix";

/**
 * The side-effect-free reader behind the composition matrix (S4 #520, ADR 0038).
 *
 * Shared by the page (initial cross) and the `/api/dashboard/cells` route
 * (prefetch). Unlike `loadDashboard` it NEVER refreshes prices or captures a
 * snapshot — it reads the already-frozen snapshots + holding rows once and
 * builds the requested cells with the same pure domain functions, so a cell from
 * the route is byte-identical to the one the page server-rendered. The matrix
 * data axes are mode × range; framing and vivienda are client-only re-renders
 * and never reach here.
 */

/** One cell's payload: a chart series or a drilldown, tagged for the client. */
export type MatrixCellPayload =
  | { kind: "chart"; series: CompositionSeriesPoint[] }
  | { kind: "drill"; drilldown: DrilldownState };

/** Everything the pure cell builder needs, read once from the store per request. */
export interface MatrixInputs {
  snapshots: readonly { dateKey: string; monthKey: string }[];
  holdingRows: DatedSnapshotHoldingRow[];
  currentHoldingIds: string[];
  trashedHoldingIds: string[];
}

/** Window the holding rows to a range (null cutoff = `all`, the full history). */
function windowRows(
  rows: DatedSnapshotHoldingRow[],
  range: CompositionRange,
  today: string,
): DatedSnapshotHoldingRow[] {
  const cutoff = rangeStartMonthKey(today, range);
  return cutoff ? rows.filter((row) => row.dateKey.slice(0, 7) >= cutoff) : rows;
}

/** Build one cell — chart series or drilldown — from already-read inputs (pure). */
export function buildMatrixCell(
  coord: MatrixCoord,
  inputs: MatrixInputs,
  today: string,
): MatrixCellPayload {
  if (coord.mode === "chart") {
    // Matches S3's per-range series: built from the FULL rows, the function
    // windows internally and only plots row-backed closes (byte-identical).
    return {
      kind: "chart",
      series: buildCompositionSeries({
        range: coord.range,
        rows: inputs.holdingRows,
        snapshots: inputs.snapshots,
        today,
      }),
    };
  }

  // A drilldown reads the range-windowed rows, exactly as `loadDashboard` does
  // for the active drill (#145) — so a route cell equals the page's render.
  return {
    kind: "drill",
    drilldown: buildDrilldown(coord.mode as DrilldownKey, {
      currentHoldingIds: inputs.currentHoldingIds,
      rows: windowRows(inputs.holdingRows, coord.range, today),
      trashedHoldingIds: inputs.trashedHoldingIds,
    }),
  };
}

/** Build the requested cells, keyed by `cellKey` (pure). */
export function buildMatrixCells(
  coords: readonly MatrixCoord[],
  inputs: MatrixInputs,
  today: string,
): Record<string, MatrixCellPayload> {
  const cells: Record<string, MatrixCellPayload> = {};
  for (const coord of coords) {
    cells[cellKey(coord)] = buildMatrixCell(coord, inputs, today);
  }
  return cells;
}

/**
 * Read the matrix inputs once for a scope: snapshots + holding rows always; the
 * current/trashed holding ids only when a drill cell is requested (they cost two
 * extra reads the chart never needs).
 */
export async function readMatrixInputs(
  store: WorthlineStore,
  scopeId: string,
  needDrillData: boolean,
): Promise<MatrixInputs> {
  const [snapshots, holdingRows] = await Promise.all([
    store.snapshots.readSnapshots(scopeId),
    store.snapshots.readSnapshotHoldings({ scopeId }),
  ]);

  if (!needDrillData) {
    return { snapshots, holdingRows, currentHoldingIds: [], trashedHoldingIds: [] };
  }

  const [assets, liabilities, trash] = await Promise.all([
    store.assets.readAssets(),
    store.liabilities.readLiabilities(),
    store.readTrash(),
  ]);

  return {
    snapshots,
    holdingRows,
    currentHoldingIds: [
      ...assets.map((asset) => asset.id),
      ...liabilities.map((liability) => liability.id),
    ],
    trashedHoldingIds: [
      ...trash.assets.map((asset) => asset.id),
      ...trash.liabilities.map((liability) => liability.id),
    ],
  };
}

/**
 * Read + build the requested cells for a scope. `scopeId === undefined` (no
 * scope) yields an empty map. The single entry point for both the page's
 * initial cross and the route's prefetch.
 */
export async function readMatrixCells(
  store: WorthlineStore,
  scopeId: string | undefined,
  coords: readonly MatrixCoord[],
  today: string,
): Promise<Record<string, MatrixCellPayload>> {
  if (!scopeId || coords.length === 0) {
    return {};
  }
  const needDrillData = coords.some((coord) => coord.mode !== "chart");
  const inputs = await readMatrixInputs(store, scopeId, needDrillData);
  return buildMatrixCells(coords, inputs, today);
}
