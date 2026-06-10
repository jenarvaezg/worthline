import { buildDecompositionChartGeometry } from "@worthline/domain";
import type { DecompositionBandId, NetWorthSnapshot } from "@worthline/domain";

/**
 * Server-rendered SVG decomposition of net worth into liquid (green),
 * housing equity (gold), and rest (blue) over the snapshot history
 * (ADR 0009, #75). Stacked areas when all bands stay ≥ 0 across the window;
 * three plain lines otherwise. Framing-invariant: it always decomposes net
 * worth, so it is identical under both Vistas. Zero client JS.
 */

const BAND_LABELS: Record<DecompositionBandId, string> = {
  housing: "Vivienda",
  liquid: "Líquido",
  rest: "Resto",
};

export default function DecompositionChart({
  snapshots,
}: {
  snapshots: NetWorthSnapshot[];
}) {
  const geometry = buildDecompositionChartGeometry(
    snapshots.map((snapshot) => ({
      dateKey: snapshot.dateKey,
      housingEquityMinor: snapshot.housingEquity.amountMinor,
      liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
      totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
    })),
  );

  // Below the placeholder threshold the evolution chart above already shows
  // the section's empty message — render nothing instead of repeating it.
  if (!geometry) return null;

  return (
    <>
      <div className="decompositionLegend" aria-label="Bandas de composición">
        {geometry.bands.map((band) => (
          <span className={band.band} key={band.band}>
            <i aria-hidden="true" />
            {BAND_LABELS[band.band]}
          </span>
        ))}
      </div>
      <svg
        className="decompositionChart"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label="Composición del patrimonio neto: líquido, vivienda y resto"
        preserveAspectRatio="none"
      >
        {geometry.mode === "stacked"
          ? geometry.bands.map((band) => (
              <polygon
                className={`decompositionBand ${band.band}`}
                key={band.band}
                points={band.areaPoints!}
              >
                <title>{BAND_LABELS[band.band]}</title>
              </polygon>
            ))
          : geometry.bands.map((band) => (
              <polyline
                className={`decompositionLine ${band.band}`}
                fill="none"
                key={band.band}
                points={band.linePoints}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              >
                <title>{BAND_LABELS[band.band]}</title>
              </polyline>
            ))}
      </svg>
    </>
  );
}
