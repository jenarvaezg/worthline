import { buildCompositionChartGeometry, formatMoneyMinor } from "@worthline/domain";
import type { CompositionAssetBandId, CompositionSeriesPoint } from "@worthline/domain";

/**
 * The dashboard's single historical chart (#142, ADR 0009): the five gross asset
 * bands stack above zero (the four liquidity rungs plus Vivienda, sourced from
 * the `property` instrument by holding id), one aggregated debt stack sits below
 * zero, and a net-worth line shows the resulting total — mirroring the domain
 * equation `gross assets − debts = net worth` directly. Server-rendered SVG, zero
 * client JS: hover values use native <title>.
 */

const ASSET_BAND_LABELS: Record<CompositionAssetBandId, string> = {
  cash: "Caja",
  illiquid: "Ilíquido",
  housing: "Vivienda",
  market: "Mercado",
  "term-locked": "A plazo",
};

export default function CompositionChart({
  currency,
  points,
}: {
  currency: string;
  points: CompositionSeriesPoint[];
}) {
  const geometry = buildCompositionChartGeometry(points);

  if (!geometry) {
    return (
      <p className="emptyLine compositionEmpty">
        La composición del patrimonio aparecerá cuando haya más capturas.
      </p>
    );
  }

  return (
    <>
      <div className="compositionLegend" aria-label="Bandas de composición">
        {geometry.assetBands.map((band) => (
          <span className={band.band} key={band.band}>
            <i aria-hidden="true" />
            {ASSET_BAND_LABELS[band.band]}
          </span>
        ))}
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
      <svg
        className="compositionChart"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label="Composición del patrimonio neto: activos por liquidez, deudas y patrimonio neto"
        preserveAspectRatio="none"
      >
        {geometry.assetBands.map((band) => (
          <polygon className={`compositionBand ${band.band}`} key={band.band} points={band.areaPoints}>
            <title>{ASSET_BAND_LABELS[band.band]}</title>
          </polygon>
        ))}
        {geometry.debtArea ? (
          <polygon className="compositionDebt" points={geometry.debtArea}>
            <title>Deudas</title>
          </polygon>
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
        {geometry.markers.map((marker) => (
          <circle
            className="compositionMarker"
            cx={marker.x}
            cy={marker.y}
            key={marker.dateKey}
            r="3"
          >
            {/* React requires <title> children to be ONE string — an array of
                text nodes hydrates differently than it server-renders. */}
            <title>
              {`${marker.dateKey} · Patrimonio neto: ${formatMoneyMinor({
                amountMinor: marker.valueMinor,
                currency,
              })}`}
            </title>
          </circle>
        ))}
      </svg>
    </>
  );
}
