import type { CompositionRange, DrilldownKey } from "@worthline/domain";
import { COMPOSITION_RANGES } from "@worthline/domain";

/**
 * The composition surface's data matrix (S4 #520, ADR 0038): one **mode** (the
 * chart or a drilldown) over one **range**. A single user action moves one step
 * along a row (change range) or down a column (change mode) — never diagonally —
 * so the only cells reachable in one click are the current row + column: the
 * **cross**. The island ships/prefetches the cross so every single click is
 * instant. Pure (no DOM/fetch) so the server initial-ship and the client
 * prefetch compute the identical set, and it unit-tests in node (§7).
 */

/** A view mode of the composition panel: the chart, or one of the four drills. */
export type CompositionMode = "chart" | DrilldownKey;

/** Every mode, chart first (the column of the matrix). */
export const COMPOSITION_MODES: readonly CompositionMode[] = [
  "chart",
  "liquid",
  "rest",
  "housing",
  "debts",
];

const DRILL_MODES: ReadonlySet<string> = new Set<CompositionMode>([
  "liquid",
  "rest",
  "housing",
  "debts",
]);

/** A cell of the matrix: a mode drawn at a range. */
export interface MatrixCoord {
  mode: CompositionMode;
  range: CompositionRange;
}

/** Stable `mode:range` key for cache maps and dedup. */
export function cellKey(coord: MatrixCoord): string {
  return `${coord.mode}:${coord.range}`;
}

/**
 * The mode a `drill` query value selects: a known drill key, else `chart` (no
 * drill). Mirrors `parseDrillParam` so the URL stays the single source of truth.
 */
export function parseMode(drill: string | null | undefined): CompositionMode {
  return drill && DRILL_MODES.has(drill) ? (drill as CompositionMode) : "chart";
}

/**
 * The cross of `coord` over the `offeredRanges`: every mode at the cell's range
 * (the column) plus the cell's mode at every offered range (the row), deduped.
 * The active cell is always included — even when its range is not offered (a
 * deep-link narrower than the history) — so the island never lacks data for the
 * window the URL asked for.
 */
export function crossOf(
  coord: MatrixCoord,
  offeredRanges: readonly CompositionRange[],
): MatrixCoord[] {
  const seen = new Set<string>();
  const cross: MatrixCoord[] = [];
  const add = (cell: MatrixCoord): void => {
    const key = cellKey(cell);
    if (!seen.has(key)) {
      seen.add(key);
      cross.push(cell);
    }
  };

  // Column: every mode at the active range.
  for (const mode of COMPOSITION_MODES) {
    add({ mode, range: coord.range });
  }
  // Row: the active mode at every offered range, plus the active range itself in
  // case the deep-link asked for a range that is not currently offered.
  for (const range of offeredRanges) {
    add({ mode: coord.mode, range });
  }
  add(coord);

  return cross;
}

/** The wanted cells absent from `have` (by key) — the prefetch diff. */
export function missingCells(
  want: readonly MatrixCoord[],
  have: ReadonlySet<string>,
): MatrixCoord[] {
  return want.filter((cell) => !have.has(cellKey(cell)));
}

/** The most cells a single request may ask for — the whole matrix, no more. */
export const MAX_REQUESTED_CELLS = COMPOSITION_MODES.length * COMPOSITION_RANGES.length;

function isMode(value: string): value is CompositionMode {
  return (COMPOSITION_MODES as readonly string[]).includes(value);
}

function isRange(value: string): value is CompositionRange {
  return (COMPOSITION_RANGES as readonly string[]).includes(value);
}

/**
 * Parse the route's `cells` query (a comma-separated list of `mode:range` keys)
 * into validated, deduped coordinates — the API's input guard (ADR 0038). Every
 * token must name a known mode and range, and the list may not exceed the matrix
 * size, so a crafted query can never fan out work. Pure, so it unit-tests apart
 * from the route.
 */
export function parseCellsParam(
  raw: string | null | undefined,
): { ok: true; coords: MatrixCoord[] } | { ok: false; error: string } {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, error: "no cells requested" };
  }
  if (tokens.length > MAX_REQUESTED_CELLS) {
    return { ok: false, error: "too many cells requested" };
  }

  const seen = new Set<string>();
  const coords: MatrixCoord[] = [];
  for (const token of tokens) {
    const [mode, range, extra] = token.split(":");
    if (extra !== undefined || !mode || !range || !isMode(mode) || !isRange(range)) {
      return { ok: false, error: `invalid cell: ${token}` };
    }
    const key = `${mode}:${range}`;
    if (!seen.has(key)) {
      seen.add(key);
      coords.push({ mode, range });
    }
  }

  return { ok: true, coords };
}
