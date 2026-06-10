import { formatMoneyMinor } from "@worthline/domain";
import type { LiquidDrillTier, LiquidDrilldownState } from "@worthline/domain";

/**
 * The liquid drill view (#76) — rendered server-side IN PLACE of the
 * decomposition chart: a breadcrumb back to the full picture (preserving the
 * Vista), the cash-vs-market stacked chart derived from frozen snapshot
 * holding rows, and a small-multiples grid with one sparkline per holding.
 * Zero client JS — plain HTML anchors, native <title> hovers.
 */

const TIER_LABELS: Record<LiquidDrillTier, string> = {
  cash: "Caja",
  market: "Mercado",
};

export default function DrilldownPanel({
  backHref,
  currency,
  drilldown,
}: {
  backHref: string;
  currency: string;
  drilldown: LiquidDrilldownState;
}) {
  const { stack, holdings } = drilldown;

  return (
    <div className="drillPanel">
      <div className="drillHeader">
        <a className="drillBreadcrumb" href={backHref}>
          ← Composición
        </a>
        <h3>Líquido · caja y mercado</h3>
      </div>

      {stack ? (
        <>
          <div className="decompositionLegend" aria-label="Capas del grupo líquido">
            {stack.bands.map((band) => (
              <span className={band.band} key={band.band}>
                <i aria-hidden="true" />
                {TIER_LABELS[band.band]}
              </span>
            ))}
          </div>
          <svg
            className="drillChart"
            viewBox={`0 0 ${stack.width} ${stack.height}`}
            role="img"
            aria-label="Evolución del líquido: caja y mercado"
            preserveAspectRatio="none"
          >
            {stack.mode === "stacked"
              ? stack.bands.map((band) => (
                  <polygon
                    className={`drillBand ${band.band}`}
                    key={band.band}
                    points={band.areaPoints!}
                  >
                    <title>{TIER_LABELS[band.band]}</title>
                  </polygon>
                ))
              : stack.bands.map((band) => (
                  <polyline
                    className={`drillLine ${band.band}`}
                    fill="none"
                    key={band.band}
                    points={band.linePoints}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{TIER_LABELS[band.band]}</title>
                  </polyline>
                ))}
          </svg>
        </>
      ) : (
        <p className="emptyLine drillEmpty">
          La evolución de caja y mercado aparecerá cuando haya más capturas.
        </p>
      )}

      {holdings.length > 0 ? (
        <div className="drillMultiples" aria-label="Posiciones del grupo líquido">
          {holdings.map((holding) => (
            <div
              className={
                holding.noLongerHeld ? "drillMultiple noLongerHeld" : "drillMultiple"
              }
              key={holding.holdingId}
            >
              <span className="drillMultipleLabel">{holding.label}</span>
              {holding.noLongerHeld || holding.currentValueMinor === null ? (
                // Frozen means frozen: the history stays, only the present is gone.
                <span className="drillMultipleGone">Ya no en cartera</span>
              ) : (
                <b>
                  {formatMoneyMinor({
                    amountMinor:
                      holding.kind === "liability"
                        ? -holding.currentValueMinor
                        : holding.currentValueMinor,
                    currency,
                  })}
                </b>
              )}
              <svg
                className={`drillSparkline ${holding.tier}`}
                viewBox={`0 0 ${holding.sparkline.width} ${holding.sparkline.height}`}
                role="img"
                aria-label={`Evolución de ${holding.label}`}
                preserveAspectRatio="none"
              >
                <polyline
                  fill="none"
                  points={holding.sparkline.linePoints}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          ))}
        </div>
      ) : (
        <p className="emptyLine drillEmpty">
          Las posiciones aparecerán cuando cada una acumule más capturas.
        </p>
      )}
    </div>
  );
}
