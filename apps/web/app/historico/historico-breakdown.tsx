/**
 * /historico "Origen del cambio" stacked chart (#653 S1, #660 S2 payout band).
 * Server-rendered SVG (ADR 0009) with a limits legend. Two bands (mercado /
 * ahorro neto) by default; a third cobros band appears when payouts exist.
 */

import type { DeltaBreakdownBandId, StackedChartGeometry } from "@worthline/domain";
import type { HistoricoBreakdownView } from "./build-historico-breakdown";

const BAND_LABELS: Record<DeltaBreakdownBandId, string> = {
  market: "Mercado",
  netSavings: "Ahorro neto",
  payouts: "Cobros",
};

type BreakdownGeometry = StackedChartGeometry<DeltaBreakdownBandId>;

function BreakdownChart({ geometry }: { geometry: BreakdownGeometry }) {
  return (
    <svg
      aria-label="Origen del cambio por cierre de mes"
      className="historicoBreakdownChart"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
    >
      {geometry.mode === "stacked" ? (
        <>
          {geometry.bands.map((band) => (
            <g
              className={`historicoBreakdownBand historicoBreakdownBand--${band.band}`}
              key={band.band}
            >
              <title>{BAND_LABELS[band.band]}</title>
              {band.bars!.map((bar, index) => (
                <rect
                  height={bar.height}
                  key={index}
                  width={bar.width}
                  x={bar.x}
                  y={bar.y}
                />
              ))}
            </g>
          ))}
          <polyline
            className="historicoBreakdownTotalLine"
            fill="none"
            points={geometry.totalLine!}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        geometry.bands.map((band) => (
          <polyline
            className={`historicoBreakdownLine historicoBreakdownLine--${band.band}`}
            fill="none"
            key={band.band}
            points={band.linePoints}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          >
            <title>{BAND_LABELS[band.band]}</title>
          </polyline>
        ))
      )}
    </svg>
  );
}

export default function HistoricoBreakdown({
  breakdown,
}: {
  breakdown: HistoricoBreakdownView;
}) {
  const { geometry, showsPayoutBand } = breakdown;
  if (!geometry) {
    return (
      <p className="emptyLine historicoBreakdownEmpty">
        El desglose por cierre de mes aparecerá cuando haya al menos dos cierres
        confirmados con filas congeladas.
      </p>
    );
  }

  const legendBands: DeltaBreakdownBandId[] = showsPayoutBand
    ? ["market", "payouts", "netSavings"]
    : ["market", "netSavings"];

  return (
    <section aria-label="Origen del cambio" className="historicoBreakdownPanel">
      <div className="panelHeader">
        <h2>Origen del cambio</h2>
      </div>

      <div
        aria-label="Bandas del desglose"
        className="decompositionLegend historicoBreakdownLegend"
      >
        {legendBands.map((band) => (
          <span
            className={`historicoBreakdownLegendItem historicoBreakdownLegendItem--${band}`}
            key={band}
          >
            <i aria-hidden="true" />
            {BAND_LABELS[band]}
          </span>
        ))}
      </div>

      <BreakdownChart geometry={geometry} />

      <p className="historicoBreakdownLimits">
        El ahorro neto es el residual: lo que entra menos lo que sale, sin intentar
        emparejar transferencias entre meses. Los cobros registrados se separan del
        residual cuando existen.
      </p>
    </section>
  );
}
