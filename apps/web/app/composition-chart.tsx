"use client";

import { buildCompositionChartGeometry, formatMoneyMinor } from "@worthline/domain";
import type {
  CompositionAssetBandId,
  CompositionSeriesPoint,
  DrilldownKey,
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
 * Interactivity (ADR 0009's sanctioned escape hatch for rich hover): a client
 * tooltip follows the cursor and lists ALL of the hovered period's values. The
 * tooltip overlay is pointer-events:none, so the asset bands stay clickable —
 * each links to its drilldown (cash/market → liquid, term-locked/illiquid →
 * rest, housing → housing). Debts have no destination. The chart still renders
 * server-side; only the hover layer needs the client.
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
  points,
}: {
  currency: string;
  /**
   * Drill URLs per group (#76/#77), each preserving the active Vista. An asset
   * band with a matching destination renders itself and its legend entry as
   * native anchors; debts never have a destination.
   */
  drillHrefs?: Partial<Record<DrilldownKey, string>>;
  points: CompositionSeriesPoint[];
}) {
  const geometry = useMemo(() => buildCompositionChartGeometry(points), [points]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number; flip: boolean } | null>(
    null,
  );

  if (!geometry) {
    return (
      <p className="emptyLine compositionEmpty">
        La composición del patrimonio aparecerá cuando haya más capturas.
      </p>
    );
  }

  const money = (amountMinor: number): string => formatMoneyMinor({ amountMinor, currency });
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
        {geometry.assetBands.map((band) => {
          const label = COMPOSITION_BAND_LABELS[band.band];
          const href = bandHref(band.band);

          return href ? (
            <a className={band.band} href={href} key={band.band}>
              <i aria-hidden="true" />
              {label}
            </a>
          ) : (
            <span className={band.band} key={band.band}>
              <i aria-hidden="true" />
              {label}
            </span>
          );
        })}
        {geometry.debtArea ? (
          <span className="debt">
            <i aria-hidden="true" />
            Deudas
          </span>
        ) : null}
        <span className="net">
          <i aria-hidden="true" />
          Patrimonio neto
        </span>
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
          {geometry.assetBands.map((band) => {
            const href = bandHref(band.band);
            const polygon = (
              <polygon className={`compositionBand ${band.band}`} points={band.areaPoints} />
            );

            // Native SVG anchor — drilldown navigation with zero client JS for the
            // navigation itself (ADR 0009). The hover tooltip overlay does not
            // block these clicks (it is pointer-events:none).
            return href ? (
              <a
                aria-label={`Ver desglose: ${COMPOSITION_BAND_LABELS[band.band]}`}
                href={href}
                key={band.band}
              >
                {polygon}
              </a>
            ) : (
              <g key={band.band}>{polygon}</g>
            );
          })}
          {geometry.debtArea ? (
            <polygon className="compositionDebt" points={geometry.debtArea} />
          ) : null}
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
            <div className="compositionTooltipDate">{formatTooltipDate(activePeriod.dateKey)}</div>
            {compositionTooltipRows(activePeriod).map((row) => (
              <div className={`compositionTooltipRow ${row.kind}`} key={row.label}>
                <span>{row.label}</span>
                <b>{row.kind === "debt" ? `−${money(row.valueMinor)}` : money(row.valueMinor)}</b>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
