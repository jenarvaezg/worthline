"use client";

import type {
  CompositionHousingMode,
  CompositionRange,
  DrilldownKey,
  NetWorthFraming,
} from "@worthline/domain";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import CompositionChart from "./composition-chart";
import { compositionUrl } from "./composition-url";
import type { MatrixCellPayload } from "./dashboard-cells";
import {
  type CompositionMode,
  cellKey,
  crossOf,
  type MatrixCoord,
  missingCells,
  parseMode,
} from "./dashboard-matrix";
import DrilldownPanel from "./drilldown-panel";
import { pushMirroredUrl, useViewStateSync } from "./url-view-state";
import {
  FRAMING_VIEW_PARAM,
  isPlainAnchorClick,
  readHousingModeFromSearch,
  readRangeFromUrl,
  readViewParam,
} from "./view-state";

/**
 * The composition surface as a client island over a 2-D matrix (S4 #520, ADR
 * 0038): mode (chart / drilldown) × range. Opening or closing a drilldown and
 * changing the range used to be server `<a>` round-trips (~2.3s on Turso, S0
 * baseline #516); now the server ships the **cross** of the current cell (the
 * column + the chart row) and this island swaps between cells from an in-memory
 * cache — instant, scroll preserved (no document navigation), URL mirrored via
 * `pushState`. After each move it prefetches the next cross from
 * `/api/dashboard/cells`, so the following click is instant too. A cache miss
 * (rapid clicks / network failure) degrades to an honest inline pending (§9).
 *
 * Two orthogonal toggles need no cell data: framing `view` is hero-only (#518)
 * and only retargets links here; `vivienda` re-derives the chart geometry from
 * the SAME points client-side. It composes with the framing (#518) and range
 * (#519) islands through the URL + the shared `VIEW_STATE_CHANGE_EVENT`. Every
 * link is built with the canonical `compositionUrl`, so the no-JS fallback,
 * deep-link and keyboard paths stay intact (§3, §8); this component is the thin
 * shell over the pure matrix logic (§7).
 */

const RANGE_LABELS: Record<CompositionRange, string> = {
  "1y": "1A",
  "3y": "3A",
  "5y": "5A",
  all: "Todo",
};

const RANGE_ANNOUNCE: Record<CompositionRange, string> = {
  "1y": "1 año",
  "3y": "3 años",
  "5y": "5 años",
  all: "todo el histórico",
};

const MODE_ANNOUNCE: Record<CompositionMode, string> = {
  chart: "composición",
  liquid: "desglose del líquido",
  rest: "desglose del resto",
  housing: "desglose de la vivienda",
  debts: "desglose de las deudas",
};

export default function CompositionPanel({
  currency,
  historicoLink,
  initialCells,
  initialHousingMode,
  initialMode,
  initialRange,
  initialView,
  offeredRanges,
  privacyMode,
}: {
  currency: string;
  /** The "Ver histórico →" link — static chrome the server renders, slotted in. */
  historicoLink: ReactNode;
  initialCells: Record<string, MatrixCellPayload>;
  initialHousingMode: CompositionHousingMode;
  initialMode: CompositionMode;
  initialRange: CompositionRange;
  initialView: NetWorthFraming;
  /** Offered range pills; under 2, the control hides (history under a year). */
  offeredRanges: readonly CompositionRange[];
  privacyMode: boolean;
}) {
  const [mode, setMode] = useState<CompositionMode>(initialMode);
  const [range, setRange] = useState<CompositionRange>(initialRange);
  const [housingMode, setHousingMode] =
    useState<CompositionHousingMode>(initialHousingMode);
  // Live framing, folded into the links this island builds so it composes with
  // the Vista island (#518) through the URL (a range/drill toggle never changes
  // it, but a framing toggle since render must be honoured).
  const [view, setView] = useState<NetWorthFraming>(initialView);
  const [cache, setCache] = useState<Record<string, MatrixCellPayload>>(initialCells);
  // Mirror the cache into a ref (updated in an effect, never during render) so
  // the prefetch closure reads the freshest keys after rapid moves.
  const cacheRef = useRef(cache);
  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  const fetchCells = useCallback(
    async (coords: readonly MatrixCoord[]): Promise<void> => {
      const missing = missingCells(coords, new Set(Object.keys(cacheRef.current)));
      if (missing.length === 0) {
        return;
      }
      const query = missing.map(cellKey).join(",");
      try {
        const response = await fetch(
          `/api/dashboard/cells?cells=${encodeURIComponent(query)}`,
          {
            headers: { accept: "application/json" },
          },
        );
        if (!response.ok) {
          return; // Degrade: keep the cache we have (§9) — no stale figure shown.
        }
        const body = (await response.json()) as {
          cells?: Record<string, MatrixCellPayload>;
        };
        if (body.cells) {
          setCache((prev) => ({ ...prev, ...body.cells }));
        }
      } catch {
        // Network failure: keep the cache; a missing current cell shows pending.
      }
    },
    // Stable: reads only `cacheRef` (synced in an effect) and `setCache`/`fetch`,
    // none of which change — so `prefetchCross` below stays stable too.
    [],
  );

  /** Prefetch the cross of a cell so the NEXT single click is already cached. */
  const prefetchCross = useCallback(
    (centre: MatrixCoord): void => {
      const eagerRanges =
        initialRange === "all"
          ? offeredRanges
          : offeredRanges.filter((option) => option !== "all");
      void fetchCells(crossOf(centre, eagerRanges));
    },
    [fetchCells, initialRange, offeredRanges],
  );

  // Reconcile with the URL on Back/Forward, bfcache restore, and sibling writes.
  const syncFromUrl = useCallback(() => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    const urlMode = parseMode(params.get("drill"));
    const urlRange = readRangeFromUrl(search, initialRange);
    const urlHousing = readHousingModeFromSearch(search);
    setMode(urlMode);
    setRange(urlRange);
    setView(readViewParam(search, FRAMING_VIEW_PARAM));
    setHousingMode(urlHousing);
    prefetchCross({ mode: urlMode, range: urlRange });
  }, [initialRange, prefetchCross]);

  useViewStateSync(syncFromUrl);

  // Prefetch the initial cell's cross on mount so the very first click is instant
  // even for cells the server did not ship (it ships the cross, so this is a
  // no-op in the common case).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only prefetch
  useEffect(() => {
    prefetchCross({ mode: initialMode, range: initialRange });
    // Mount only: prefetchCross is stable and the initial coords are fixed —
    // adding deps would re-fire redundant prefetches on every toggle.
  }, []);

  // A cache miss for the cell we must render now (rapid moves / cold prefetch /
  // network failure): fetch it in the foreground; `!currentCell` shows the
  // pending placeholder until it lands (§9). No setState in the effect body —
  // the async cache update re-renders.
  const currentKey = cellKey({ mode, range });
  const currentCell = cache[currentKey];
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch only when cell key or cache entry changes
  useEffect(() => {
    if (!currentCell) {
      void fetchCells([{ mode, range }]);
    }
  }, [currentKey, currentCell]);

  /** The single state transition: mirror to the URL, set state, prefetch next. */
  const goTo = useCallback(
    (next: {
      mode?: CompositionMode;
      range?: CompositionRange;
      housingMode?: CompositionHousingMode;
    }): void => {
      const liveView = readViewParam(window.location.search, FRAMING_VIEW_PARAM);
      const nextMode = next.mode ?? mode;
      const nextRange = next.range ?? range;
      const nextHousing = next.housingMode ?? housingMode;
      const href = compositionUrl(
        liveView,
        nextMode === "chart" ? null : nextMode,
        nextRange,
        nextHousing,
        false,
      );
      pushMirroredUrl(`${href}${window.location.hash || "#composicion"}`);
      setView(liveView);
      setMode(nextMode);
      setRange(nextRange);
      setHousingMode(nextHousing);
      prefetchCross({ mode: nextMode, range: nextRange });
    },
    [mode, range, housingMode, prefetchCross],
  );

  const selectRange =
    (next: CompositionRange) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainAnchorClick(event)) {
        return; // modified click (new tab/window) → let the href navigate
      }
      event.preventDefault();
      if (next !== range) {
        goTo({ range: next });
      }
    };

  const onDrill = (key: DrilldownKey): void => goTo({ mode: key });
  const onBack = (): void => goTo({ mode: "chart" });
  const onToggleHousing = (): void =>
    goTo({ housingMode: housingMode === "hidden" ? "net" : "hidden" });

  // Links for the children, built canonically from the live state (§3).
  const drillKeys: DrilldownKey[] = ["liquid", "rest", "housing", "debts"];
  const drillHrefs = Object.fromEntries(
    drillKeys.map((key) => [key, compositionUrl(view, key, range, housingMode)]),
  ) as Partial<Record<DrilldownKey, string>>;
  const housingToggleHref = compositionUrl(
    view,
    mode === "chart" ? null : mode,
    range,
    housingMode === "hidden" ? "net" : "hidden",
  );
  const backHref = compositionUrl(view, null, range, housingMode);

  const showPending = !currentCell;

  return (
    <>
      <div className="panelHeader">
        <h2>Evolución</h2>
        <div className="historyControls">
          {offeredRanges.length >= 2 ? (
            <nav className="rangeTabs" aria-label="Rango temporal de la composición">
              {offeredRanges.map((option) => {
                const isActive = option === range;
                return (
                  <a
                    aria-current={isActive ? "true" : undefined}
                    className={isActive ? "active" : undefined}
                    href={compositionUrl(
                      view,
                      mode === "chart" ? null : mode,
                      option,
                      housingMode,
                    )}
                    key={option}
                    onClick={selectRange(option)}
                  >
                    {RANGE_LABELS[option]}
                  </a>
                );
              })}
            </nav>
          ) : null}
          {historicoLink}
        </div>
      </div>
      {/* Announce the client swap for screen readers — it is not a document
          navigation, so nothing else announces it (§8). */}
      <p aria-live="polite" className="srOnly">
        {`Vista: ${MODE_ANNOUNCE[mode]} · rango ${RANGE_ANNOUNCE[range]}`}
      </p>

      {showPending ? (
        <p className="emptyLine compositionPending" aria-busy="true">
          Cargando…
        </p>
      ) : currentCell.kind === "drill" ? (
        <DrilldownPanel
          backHref={backHref}
          currency={currency}
          drilldown={currentCell.drilldown}
          onBack={onBack}
          privacyMode={privacyMode}
        />
      ) : (
        <CompositionChart
          currency={currency}
          drillHrefs={drillHrefs}
          housingMode={housingMode}
          housingToggleHref={housingToggleHref}
          onDrill={onDrill}
          onToggleHousing={onToggleHousing}
          points={currentCell.series}
          privacyMode={privacyMode}
        />
      )}
    </>
  );
}
