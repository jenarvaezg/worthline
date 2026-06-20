import { formatMoneyMinor } from "@worthline/domain";
import type { DrilldownKey, DrilldownState, LiquidityTier } from "@worthline/domain";

/**
 * The drill view (#76 liquid, #77 rest + housing) — rendered server-side IN
 * PLACE of the decomposition chart: a breadcrumb back to the full picture
 * (preserving the Vista), the group's per-tier stacked chart derived from
 * frozen snapshot holding rows — drawn as per-period BARS with a total line
 * over them (this design pass), mirroring the main composition chart — and a
 * small-multiples grid of bordered cards, one per currently-held holding, each
 * with a bar sparkline. Housing is a single tier, so its panel skips the stack
 * and goes straight to the per-property multiples. Zero client JS — plain HTML
 * anchors, native <title> hovers.
 */

const BAND_LABELS: Record<LiquidityTier | "debts", string> = {
  cash: "Caja",
  debts: "Deudas",
  housing: "Vivienda",
  illiquid: "Ilíquido",
  market: "Mercado",
  "term-locked": "A plazo",
};

/**
 * Per-group copy: heading, aria labels, and placeholder text. Groups without
 * `stackCopy` render no stack section at all — housing is a single tier, so
 * its drill goes straight to the per-property multiples (#77).
 */
const GROUP_COPY: Record<
  DrilldownKey,
  {
    title: string;
    multiplesAria: string;
    stackCopy?: { legendAria: string; chartAria: string; empty: string };
  }
> = {
  debts: {
    multiplesAria: "Deudas individuales",
    stackCopy: {
      chartAria: "Evolución de las deudas agregadas",
      empty: "La evolución de las deudas aparecerá cuando haya más capturas.",
      legendAria: "Banda de deudas agregadas",
    },
    title: "Deudas · obligaciones",
  },
  housing: {
    multiplesAria: "Propiedades del grupo vivienda",
    title: "Vivienda · propiedades",
  },
  liquid: {
    multiplesAria: "Posiciones del grupo líquido",
    stackCopy: {
      chartAria: "Evolución del líquido: caja y mercado",
      empty: "La evolución de caja y mercado aparecerá cuando haya más capturas.",
      legendAria: "Capas del grupo líquido",
    },
    title: "Líquido · caja y mercado",
  },
  rest: {
    multiplesAria: "Posiciones del grupo resto",
    stackCopy: {
      chartAria: "Evolución del resto: a plazo e ilíquido",
      empty: "La evolución de a plazo e ilíquido aparecerá cuando haya más capturas.",
      legendAria: "Capas del grupo resto",
    },
    title: "Resto · a plazo e ilíquido",
  },
};

export default function DrilldownPanel({
  backHref,
  currency,
  drilldown,
}: {
  backHref: string;
  currency: string;
  drilldown: DrilldownState;
}) {
  const { key, stack, holdings } = drilldown;
  const copy = GROUP_COPY[key];
  const stackCopy = copy.stackCopy;

  return (
    <div className="drillPanel">
      <div className="drillHeader">
        <a className="drillBreadcrumb" href={backHref}>
          ← Composición
        </a>
        <h3>{copy.title}</h3>
      </div>

      {stackCopy ? (
        stack ? (
          <>
            <div className="decompositionLegend" aria-label={stackCopy.legendAria}>
              {stack.bands.map((band) => (
                <span className={band.band} key={band.band}>
                  <i aria-hidden="true" />
                  {BAND_LABELS[band.band]}
                </span>
              ))}
            </div>
            <svg
              className="drillChart"
              viewBox={`0 0 ${stack.width} ${stack.height}`}
              role="img"
              aria-label={stackCopy.chartAria}
              preserveAspectRatio="none"
            >
              {stack.mode === "stacked" ? (
                <>
                  {/* Stacked per-period BARS (this design pass), mirroring the
                      main composition chart; a zero-value period yields a
                      zero-height rect that simply does not paint. */}
                  {stack.bands.map((band) => (
                    <g className={`drillBand ${band.band}`} key={band.band}>
                      <title>{BAND_LABELS[band.band]}</title>
                      {band.bars!.map((bar, i) => (
                        <rect
                          height={bar.height}
                          key={i}
                          width={bar.width}
                          x={bar.x}
                          y={bar.y}
                        />
                      ))}
                    </g>
                  ))}
                  {/* The total line rides over the bars (the stack's top edge). */}
                  <polyline
                    className="drillTotalLine"
                    fill="none"
                    points={stack.totalLine!}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              ) : (
                stack.bands.map((band) => (
                  <polyline
                    className={`drillLine ${band.band}`}
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
          </>
        ) : (
          <p className="emptyLine drillEmpty">{stackCopy.empty}</p>
        )
      ) : null}

      {holdings.length > 0 ? (
        <div className="drillMultiples" aria-label={copy.multiplesAria}>
          {holdings.map((holding) => (
            <div className="drillMultiple" key={holding.holdingId}>
              <span className="drillMultipleLabel">{holding.label}</span>
              <b>
                {formatMoneyMinor({
                  amountMinor:
                    holding.kind === "liability"
                      ? -holding.currentValueMinor
                      : holding.currentValueMinor,
                  currency,
                })}
              </b>
              <svg
                className={`drillSparkline ${holding.tier ?? "debt"}`}
                viewBox={`0 0 ${holding.sparkline.width} ${holding.sparkline.height}`}
                role="img"
                aria-label={`Evolución de ${holding.label}`}
                preserveAspectRatio="none"
              >
                {/* Per-capture BARS with a floored height (this design pass) so a
                    one- or two-point history reads as clean discrete ticks. */}
                {holding.sparkline.bars.map((bar, i) => (
                  <rect
                    height={bar.height}
                    key={i}
                    width={bar.width}
                    x={bar.x}
                    y={bar.y}
                  />
                ))}
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
