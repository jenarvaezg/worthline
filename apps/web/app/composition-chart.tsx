import { buildCompositionChartGeometry, formatMoneyMinor } from "@worthline/domain";
import type {
  CompositionAssetBandId,
  CompositionSeriesPoint,
  DrilldownKey,
} from "@worthline/domain";

/**
 * The dashboard's single historical chart (#142, ADR 0009): the five gross asset
 * bands stack above zero (the four liquidity rungs plus Vivienda, sourced from
 * the `property` instrument by holding id), one aggregated debt stack sits below
 * zero, and a net-worth line shows the resulting total — mirroring the domain
 * equation `gross assets − debts = net worth` directly.
 *
 * Interactivity stays native (#143): every component exposes a per-period <title>
 * with date, label and value, and the asset bands link to their drilldown when
 * the destination is unambiguous (cash/market → liquid, term-locked/illiquid →
 * rest, housing → housing). Debts have no destination. Zero client JS.
 */

const ASSET_BAND_LABELS: Record<CompositionAssetBandId, string> = {
  cash: "Caja",
  illiquid: "Ilíquido",
  housing: "Vivienda",
  market: "Mercado",
  "term-locked": "A plazo",
};

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
   * native anchors; without one it stays plain. Debts never have a destination.
   */
  drillHrefs?: Partial<Record<DrilldownKey, string>>;
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

  const money = (amountMinor: number): string => formatMoneyMinor({ amountMinor, currency });
  const bandHref = (band: CompositionAssetBandId): string | undefined =>
    drillHrefs?.[BAND_DRILL_KEY[band]];

  return (
    <>
      <div className="compositionLegend" aria-label="Bandas de composición">
        {geometry.assetBands.map((band) => {
          const label = ASSET_BAND_LABELS[band.band];
          const href = bandHref(band.band);

          // The legend doubles as navigation (#143): an asset entry whose drill
          // destination is unambiguous renders as a link, otherwise a plain span.
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
      <svg
        className="compositionChart"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-label="Composición del patrimonio neto: activos por liquidez, deudas y patrimonio neto"
        preserveAspectRatio="none"
      >
        {geometry.assetBands.map((band) => {
          const label = ASSET_BAND_LABELS[band.band];
          const href = bandHref(band.band);
          const polygon = (
            <polygon className={`compositionBand ${band.band}`} points={band.areaPoints}>
              <title>{label}</title>
            </polygon>
          );

          // Native SVG anchor — drilldown navigation with zero client JS (ADR 0009).
          return href ? (
            <a aria-label={`Ver desglose: ${label}`} href={href} key={band.band}>
              {polygon}
            </a>
          ) : (
            <g key={band.band}>{polygon}</g>
          );
        })}
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
        {/* Per-period hover hit targets — one per band, the debt and the net
            line — each exposing date, label and value via native <title> (#143).
            React requires <title> children to be ONE string. */}
        {geometry.periods.flatMap((period) => [
          ...period.assetBands.map((anchor) => (
            <circle
              cx={anchor.x}
              cy={anchor.y}
              fill="transparent"
              key={`${period.dateKey}-${anchor.band}`}
              pointerEvents="all"
              r="7"
            >
              <title>
                {`${period.dateKey} · ${ASSET_BAND_LABELS[anchor.band]}: ${money(anchor.valueMinor)}`}
              </title>
            </circle>
          )),
          ...(period.debt
            ? [
                <circle
                  cx={period.debt.x}
                  cy={period.debt.y}
                  fill="transparent"
                  key={`${period.dateKey}-debt`}
                  pointerEvents="all"
                  r="7"
                >
                  <title>{`${period.dateKey} · Deudas: ${money(period.debt.valueMinor)}`}</title>
                </circle>,
              ]
            : []),
          <circle
            cx={period.netWorth.x}
            cy={period.netWorth.y}
            fill="transparent"
            key={`${period.dateKey}-net`}
            pointerEvents="all"
            r="7"
          >
            <title>
              {`${period.dateKey} · Patrimonio neto: ${money(period.netWorth.valueMinor)}`}
            </title>
          </circle>,
        ])}
      </svg>
    </>
  );
}
