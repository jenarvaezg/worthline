import type { HoldingReturnsView } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

import { formatMeasurePct, formatRatioPct } from "@web/_components/returns-format";

/**
 * The holding ficha's returns surface (#551, ADR 0040): the three present-time
 * measures — simple total gain, money-weighted IRR, time-weighted TWR — with the
 * realized/unrealized split legible and the honest caveats surfaced, not buried.
 * Server-rendered (RSC-first, ADR 0036); the figures are derived, never stored,
 * and the net-worth math never reads them. Sub-year spans stay total (never
 * annualized). A measure that could not be computed shows an em dash, not a
 * fabricated number.
 */
function signClass(amountMinor: number): "pos" | "neg" {
  return amountMinor >= 0 ? "pos" : "neg";
}

function signedMoney(
  value: { amountMinor: number; currency: string },
  privacyMode: boolean,
): string {
  const prefix = value.amountMinor > 0 ? "+" : "";
  return `${prefix}${formatMoneyMinorPrivacy(value, privacyMode)}`;
}

export function ReturnsPanel({
  view,
  privacyMode,
}: {
  view: HoldingReturnsView;
  privacyMode: boolean;
}) {
  return (
    <section className="returnsPanel" aria-label="Rentabilidad">
      <h3>Rentabilidad</h3>

      <dl className="returnsMeasures">
        <div className="returnsMeasure">
          <dt>Ganancia simple {view.annualized ? "(total)" : "(total, no anual)"}</dt>
          <dd className={signClass(view.totalGain.amountMinor)}>
            {signedMoney(view.totalGain, privacyMode)} ·{" "}
            {formatMeasurePct(view.totalReturnRatio)}
          </dd>
        </div>

        {view.annualized && view.cagr !== null ? (
          <div className="returnsMeasure">
            <dt>Anualizada (CAGR)</dt>
            <dd>{formatRatioPct(view.cagr)}</dd>
          </div>
        ) : null}

        {view.irr ? (
          <div className="returnsMeasure">
            <dt>IRR (anual, ponderada por dinero)</dt>
            <dd>{formatMeasurePct(view.irr.rate)}</dd>
          </div>
        ) : null}

        {view.twr ? (
          <div className="returnsMeasure">
            <dt>
              TWR (ponderada por tiempo)
              {view.twr.provisional ? " · provisional" : ""}
            </dt>
            <dd>{formatMeasurePct(view.twr.rate)}</dd>
          </div>
        ) : null}
      </dl>

      {view.realizedPnl || view.unrealizedPnl ? (
        <dl className="returnsSplit">
          {view.realizedPnl ? (
            <div className="returnsMeasure">
              <dt>P/L realizado</dt>
              <dd className={signClass(view.realizedPnl.amountMinor)}>
                {signedMoney(view.realizedPnl, privacyMode)}
              </dd>
            </div>
          ) : null}
          {view.unrealizedPnl ? (
            <div className="returnsMeasure">
              <dt>P/L latente</dt>
              <dd className={signClass(view.unrealizedPnl.amountMinor)}>
                {signedMoney(view.unrealizedPnl, privacyMode)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {view.caveats.length > 0 ? (
        <ul className="returnsCaveats">
          {view.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
