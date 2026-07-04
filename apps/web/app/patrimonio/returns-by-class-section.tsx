import type { AssetClassReturnsViewResult } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

import { formatMeasurePct } from "@web/_components/returns-format";

import { assetClassLabel, formatExposureWeight } from "./exposure-view";

/**
 * The per-asset-class returns section on /patrimonio (PRD #552, ADR 0040 fast-
 * follow): how each asset class rinde, decomposing the portfolio returns by the
 * present-time exposure-profile class weights (a 60/40 fund gives 60% of its
 * result to renta variable, 40% to renta fija). Server-rendered (RSC-first, ADR
 * 0036); the figures are derived, never stored, and the net-worth math never reads
 * them. A class with no resolvable holdings is `Sin clasificar` — honest coverage,
 * never hidden — and gains/losses use the semantic sign colours, not raw
 * green/red (design-system.md). A measure that could not be computed shows an em
 * dash, never a fabricated number.
 */
function signClass(ratio: number | null): "pos" | "neg" | "" {
  if (ratio === null || ratio === 0) {
    return "";
  }
  return ratio > 0 ? "pos" : "neg";
}

export default function ReturnsByClassSection({
  returns,
  privacyMode,
}: {
  returns: AssetClassReturnsViewResult;
  privacyMode: boolean;
}) {
  const totalMinor = returns.classes.reduce(
    (sum, entry) => sum + entry.value.amountMinor,
    0,
  );
  const weightOf = (amountMinor: number): string =>
    totalMinor > 0 ? (amountMinor / totalMinor).toString() : "0";

  return (
    <section
      className="returnsByClassSection"
      aria-label="Rentabilidad por clase de activo"
    >
      <div className="panelHeader">
        <h2>Rentabilidad por clase</h2>
        <span>Cómo rinde cada clase de activo</span>
      </div>

      <ul className="returnsClassRows">
        {returns.classes.map((entry) => (
          <li className="returnsClassRow" key={entry.key}>
            <div className="returnsClassHead">
              <span className="returnsClassLabel">{assetClassLabel(entry.key)}</span>
              <b>{formatMoneyMinorPrivacy(entry.value, privacyMode)}</b>
              <span className="returnsClassShare">
                {formatExposureWeight(weightOf(entry.value.amountMinor))}
              </span>
            </div>
            <dl className="returnsClassMeasures">
              <div>
                <dt>Ganancia</dt>
                <dd className={signClass(entry.view.totalReturnRatio)}>
                  {formatMeasurePct(entry.view.totalReturnRatio)}
                </dd>
              </div>
              <div>
                <dt>IRR</dt>
                <dd>{formatMeasurePct(entry.view.irr?.rate ?? null)}</dd>
              </div>
              <div>
                <dt>TWR</dt>
                <dd>{formatMeasurePct(entry.view.twr?.rate ?? null)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <dl className="exposureCoverage">
        <div className="exposureCoveragePart classified">
          <dt>Clasificado</dt>
          <dd>{formatMoneyMinorPrivacy(returns.coverage.classified, privacyMode)}</dd>
        </div>
        <div className="exposureCoveragePart unknown">
          <dt>Sin clasificar</dt>
          <dd>{formatMoneyMinorPrivacy(returns.coverage.unknown, privacyMode)}</dd>
        </div>
      </dl>

      <p className="returnsByClassCaveat">
        Reparto con los pesos actuales del perfil de exposición (no históricos). No
        incluye dividendos ni cupones.
      </p>
    </section>
  );
}
