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

const DRILL_ARIA_LABELS: Record<DecompositionBandId, string> = {
  housing: "Ver desglose de la vivienda",
  liquid: "Ver desglose del líquido",
  rest: "Ver desglose del resto",
};

export default function DecompositionChart({
  drillHrefs,
  snapshots,
}: {
  /**
   * Drill URLs per band (#76 liquid, #77 rest + housing). Each band with an
   * entry renders itself and its legend entry as native SVG/HTML anchors to
   * its drill view; bands without one stay plain.
   */
  drillHrefs?: Partial<Record<DecompositionBandId, string>>;
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
        {geometry.bands.map((band) => {
          const href = drillHrefs?.[band.band];

          return href ? (
            <a className={band.band} href={href} key={band.band}>
              <i aria-hidden="true" />
              {BAND_LABELS[band.band]}
            </a>
          ) : (
            <span className={band.band} key={band.band}>
              <i aria-hidden="true" />
              {BAND_LABELS[band.band]}
            </span>
          );
        })}
      </div>
      <svg
        className="decompositionChart"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label="Composición del patrimonio neto: líquido, vivienda y resto"
        preserveAspectRatio="none"
      >
        {geometry.mode === "stacked"
          ? geometry.bands.map((band) => {
              const href = drillHrefs?.[band.band];
              const polygon = (
                <polygon
                  className={`decompositionBand ${band.band}`}
                  points={band.areaPoints!}
                >
                  <title>{BAND_LABELS[band.band]}</title>
                </polygon>
              );

              // Native SVG anchor — drilldown navigation with zero client JS
              // (ADR 0009).
              return href ? (
                <a
                  aria-label={DRILL_ARIA_LABELS[band.band]}
                  href={href}
                  key={band.band}
                >
                  {polygon}
                </a>
              ) : (
                <g key={band.band}>{polygon}</g>
              );
            })
          : geometry.bands.map((band) => {
              const href = drillHrefs?.[band.band];
              const polyline = (
                <polyline
                  className={`decompositionLine ${band.band}`}
                  fill="none"
                  points={band.linePoints}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{BAND_LABELS[band.band]}</title>
                </polyline>
              );

              return href ? (
                <a
                  aria-label={DRILL_ARIA_LABELS[band.band]}
                  href={href}
                  key={band.band}
                >
                  {polyline}
                </a>
              ) : (
                <g key={band.band}>{polyline}</g>
              );
            })}
      </svg>
    </>
  );
}
