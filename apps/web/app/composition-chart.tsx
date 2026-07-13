"use client";

import type {
  CompositionAssetBandId,
  CompositionHousingMode,
  CompositionSeriesPoint,
  DrilldownKey,
} from "@worthline/domain";
import {
  buildCompositionChartGeometry,
  COMPOSITION_ASSET_BANDS,
  formatMoneyMinorPrivacy,
} from "@worthline/domain";
import { type MouseEvent, useMemo, useRef, useState } from "react";

import {
  COMPOSITION_BAND_LABELS,
  compositionTooltipRows,
  formatTooltipDate,
  nearestPeriodIndex,
} from "./composition-chart-hover";

/**
 * The dashboard's single historical chart (#142, #143): the five gross asset
 * bands stack above zero (the four liquidity rungs plus Vivienda, sourced from
 * the `property` instrument by holding id), one aggregated debt stack sits below
 * zero, and a net-worth line shows the total — mirroring `gross − debts = net`.
 *
 * Bands draw as stacked monthly BARS (this design pass): one rectangle per
 * period per band above the zero baseline, debts as rectangles below it, and the
 * net-worth polyline over the total. Vivienda defaults to NET equity — its
 * securing mortgage folds into the band — and the "Ocultar vivienda" control is
 * URL state (ADR 0009) so the choice survives range/view/drill navigation.
 *
 * Interactivity (ADR 0009's sanctioned escape hatch for rich hover): a client
 * tooltip follows the cursor and lists ALL of the hovered period's values. The
 * tooltip overlay is pointer-events:none, so the asset bars stay clickable —
 * each links to its drilldown (cash/market → liquid, term-locked/illiquid →
 * rest, housing → housing, and the debt band → debts, #145). The chart still
 * renders server-side; only the hover layer needs the client.
 */

/** Which drill an asset band navigates to (the ADR 0013 grouping). */
const BAND_DRILL_KEY: Record<CompositionAssetBandId, DrilldownKey> = {
  cash: "liquid",
  illiquid: "rest",
  housing: "housing",
  market: "liquid",
  "term-locked": "rest",
};

export default function CompositionChart({
  currency,
  drillHrefs,
  housingMode = "net",
  housingToggleHref,
  onDrill,
  onToggleHousing,
  points,
  privacyMode = false,
}: {
  currency: string;
  /**
   * Drill URLs per group (#76/#77), each preserving the active Vista. An asset
   * band with a matching destination renders itself and its legend entry as
   * native anchors; debts never have a destination.
   */
  drillHrefs?: Partial<Record<DrilldownKey, string>>;
  /**
   * Vivienda presentation, URL-driven (ADR 0009): `"net"` equity (default) or
   * `"hidden"`. Persisted via the `vivienda` param so it survives range/view/
   * drill navigation. (`"gross"` exists in the domain but the dashboard toggles
   * only between net and hidden.)
   */
  housingMode?: CompositionHousingMode;
  /** The href the "Ocultar/Mostrar vivienda" link points to (toggles the mode). */
  housingToggleHref?: string;
  /**
   * Open a drilldown as CLIENT state (S4 #520): when set, a plain left-click on
   * an asset band, the debt band or a legend entry is intercepted and toggled in
   * place — no round-trip. The anchors keep their `href` for the no-JS, deep-link
   * and middle-click paths (§3, §8).
   */
  onDrill?: (key: DrilldownKey) => void;
  /** Toggle vivienda as client state (S4): re-derives geometry from the same points. */
  onToggleHousing?: () => void;
  points: CompositionSeriesPoint[];
  privacyMode?: boolean;
}) {
  const housingHidden = housingMode === "hidden";
  // Intercept a plain left-click to toggle client-side; let modified clicks
  // (new tab/window) and non-primary buttons follow the anchor's href.
  const drillClick =
    (key: DrilldownKey | undefined) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onDrill || key === undefined) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      onDrill(key);
    };
  const housingClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onToggleHousing) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onToggleHousing();
  };
  const geometry = useMemo(
    () => buildCompositionChartGeometry(points, { housingMode }),
    [points, housingMode],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    y: number;
    flip: boolean;
  } | null>(null);

  if (!geometry) {
    return (
      <p className="emptyLine compositionEmpty">
        La composición del patrimonio aparecerá cuando haya más capturas.
      </p>
    );
  }

  const money = (amountMinor: number): string =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const bandHref = (band: CompositionAssetBandId): string | undefined =>
    drillHrefs?.[BAND_DRILL_KEY[band]];
  const periodXs = geometry.periods.map((period) => period.netWorth.x);

  const handleMove = (event: MouseEvent<HTMLDivElement>): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const offsetX = event.clientX - rect.left;
    const viewBoxX = (offsetX / rect.width) * geometry.width;
    setHover({
      flip: offsetX > rect.width / 2,
      index: nearestPeriodIndex(periodXs, viewBoxX),
      x: offsetX,
      y: event.clientY - rect.top,
    });
  };

  const activePeriod = hover ? geometry.periods[hover.index] : undefined;

  return (
    <>
      <div className="compositionLegend" aria-label="Bandas de composición">
        {/* All bands are listed (not just the shown ones) so Vivienda stays a
            visible, dimmed cue while hidden. */}
        {COMPOSITION_ASSET_BANDS.map((band) => {
          const label = COMPOSITION_BAND_LABELS[band];
          const href = bandHref(band);
          const className = housingHidden && band === "housing" ? `${band} hidden` : band;

          return href ? (
            <a
              className={className}
              href={href}
              key={band}
              onClick={drillClick(BAND_DRILL_KEY[band])}
            >
              <i aria-hidden="true" />
              {label}
            </a>
          ) : (
            <span className={className} key={band}>
              <i aria-hidden="true" />
              {label}
            </span>
          );
        })}
        {geometry.debtBars ? (
          drillHrefs?.debts ? (
            <a className="debt" href={drillHrefs.debts} onClick={drillClick("debts")}>
              <i aria-hidden="true" />
              Deudas
            </a>
          ) : (
            <span className="debt">
              <i aria-hidden="true" />
              Deudas
            </span>
          )
        ) : null}
        <span className="net">
          <i aria-hidden="true" />
          Patrimonio neto
        </span>
        {/* Vivienda can dwarf everything else; folding it out is URL state (ADR
            0009) so the choice survives range/view/drill changes — a link, not a
            client gesture. */}
        {housingToggleHref ? (
          <a
            className="compositionToggle"
            href={housingToggleHref}
            onClick={housingClick}
          >
            {housingHidden ? "Mostrar vivienda" : "Ocultar vivienda"}
          </a>
        ) : null}
      </div>
      <div
        className="compositionChartWrap"
        onMouseLeave={() => setHover(null)}
        onMouseMove={handleMove}
        ref={wrapRef}
      >
        <svg
          className="compositionChart"
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          role="img"
          aria-label="Composición del patrimonio neto: activos por liquidez, deudas y patrimonio neto"
          preserveAspectRatio="none"
        >
          {/* Illiquid tiers (Vivienda + Ilíquido) read as "not cash" via a
              diagonal hatch of their own colour (canon §6); liquid tiers stay
              solid. Vertical lines rotated 45° tile into an even cross-hatch. */}
          <defs>
            <pattern
              height="6"
              id="housingHatch"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
              width="6"
            >
              <line
                stroke="var(--tier-housing)"
                strokeWidth="3"
                x1="0"
                x2="0"
                y1="0"
                y2="6"
              />
            </pattern>
            <pattern
              height="6"
              id="illiquidHatch"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
              width="6"
            >
              <line
                stroke="var(--tier-illiquid)"
                strokeWidth="3"
                x1="0"
                x2="0"
                y1="0"
                y2="6"
              />
            </pattern>
          </defs>
          {geometry.assetBands.map((band) => {
            const href = bandHref(band.band);
            // One stacked bar rectangle per period; a zero-value period yields a
            // zero-height rect that simply does not paint.
            const rects = band.bars.map((bar, i) => (
              <rect
                className={`compositionBand ${band.band}`}
                height={bar.height}
                key={geometry.periods[i]!.dateKey}
                width={bar.width}
                x={bar.x}
                y={bar.y}
              />
            ));

            // Native SVG anchor — drilldown navigation with zero client JS for the
            // navigation itself (ADR 0009). The hover tooltip overlay does not
            // block these clicks (it is pointer-events:none).
            return href ? (
              <a
                aria-label={`Ver desglose: ${COMPOSITION_BAND_LABELS[band.band]}`}
                href={href}
                key={band.band}
                onClick={drillClick(BAND_DRILL_KEY[band.band])}
              >
                {rects}
              </a>
            ) : (
              <g key={band.band}>{rects}</g>
            );
          })}
          {geometry.debtBars
            ? (() => {
                const rects = geometry.debtBars.map((bar, i) => (
                  <rect
                    className="compositionDebt"
                    height={bar.height}
                    key={geometry.periods[i]!.dateKey}
                    width={bar.width}
                    x={bar.x}
                    y={bar.y}
                  />
                ));

                // Native SVG anchor to the debts drilldown (#145), like the asset
                // bars — the hover overlay is pointer-events:none so it stays clickable.
                return drillHrefs?.debts ? (
                  <a
                    aria-label="Ver desglose: Deudas"
                    href={drillHrefs.debts}
                    onClick={drillClick("debts")}
                  >
                    {rects}
                  </a>
                ) : (
                  <g>{rects}</g>
                );
              })()
            : null}
          {/* Zero baseline — assets above, debts below. */}
          <line
            className="compositionBaseline"
            x1={0}
            x2={geometry.width}
            y1={geometry.baselineY}
            y2={geometry.baselineY}
          />
          <polyline
            className="compositionNetLine"
            fill="none"
            points={geometry.netWorthLine}
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
          />
          {/* Visible dots on finalized monthly closes; the open period stays bare. */}
          {geometry.periods
            .filter((period) => !period.isOpenPeriod)
            .map((period) => (
              <circle
                className="compositionMarker"
                cx={period.netWorth.x}
                cy={period.netWorth.y}
                key={period.dateKey}
                r="3"
              />
            ))}
          {/* Vertical guide at the hovered period. */}
          {activePeriod ? (
            <line
              className="compositionGuide"
              x1={activePeriod.netWorth.x}
              x2={activePeriod.netWorth.x}
              y1={0}
              y2={geometry.height}
            />
          ) : null}
        </svg>
        {activePeriod && hover ? (
          <div
            aria-hidden="true"
            className="compositionTooltip"
            style={{
              left: hover.x,
              top: hover.y,
              transform: `translate(${hover.flip ? "calc(-100% - 14px)" : "14px"}, -50%)`,
            }}
          >
            <div className="compositionTooltipDate">
              {formatTooltipDate(activePeriod.dateKey)}
            </div>
            {compositionTooltipRows(activePeriod).map((row) => (
              <div className={`compositionTooltipRow ${row.kind}`} key={row.label}>
                <span>{row.label}</span>
                <b>
                  {row.kind === "debt"
                    ? `−${money(row.valueMinor)}`
                    : money(row.valueMinor)}
                </b>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
