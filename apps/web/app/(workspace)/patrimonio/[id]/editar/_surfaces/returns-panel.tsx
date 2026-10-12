import {
  formatMeasurePct,
  formatRatioPct,
  irrUnavailableReason,
  signClass,
  twrUnavailableReason,
} from "@web/_components/returns-format";
import type { HoldingReturnsView, MoneyMinor } from "@worthline/domain";
import {
  costBasisGradeMark,
  formatDateKeyEs,
  formatMoneyMinorPrivacy,
} from "@worthline/domain";
import type { ReactNode } from "react";

/**
 * The holding ficha's «Rentabilidad» tab (#551, ADR 0040; laid out by #1830).
 *
 * Two questions faced, side by side, instead of five measures stacked in a column:
 *
 * - **Tu dinero (TIR)** — how the owner did, where WHEN each euro went in counts: the
 *   money-weighted return as its headline, then the gain in euros with the realized
 *   part against the latent one.
 * - **El fondo (TWR)** — how the product did whatever those dates were: the
 *   time-weighted return, dated from its first monthly close, and beside it the
 *   comparison with its index, because the TWR is the measure an index compares.
 *
 * Server-rendered (RSC-first, ADR 0036); the figures are derived, never stored, and
 * the net-worth math never reads them. A span under a year stays total, never
 * annualized; a measure that could not be computed shows an em dash AND says why —
 * a bare dash where a headline should be reads as a bug, not as an honest absence.
 */

function signedMoney(value: MoneyMinor, privacyMode: boolean): string {
  const prefix = value.amountMinor > 0 ? "+" : "";
  return `${prefix}${formatMoneyMinorPrivacy(value, privacyMode)}`;
}

/** A side's leading figure: the rate, what span it speaks for, and what it means. */
function Headline({
  caption,
  rate,
  span,
}: {
  caption: string;
  rate: number | null;
  /** «al año» or «en total, no anual»; absent with no figure to qualify. */
  span: string | null;
}) {
  return (
    <>
      <p className="returnsHeadline">
        <span className={signClass(rate)}>{formatMeasurePct(rate)}</span>
        {rate !== null && span ? <small> {span}</small> : null}
      </p>
      <p className="returnsLede">{caption}</p>
    </>
  );
}

/** One line of a side: what it is, and its figure right-aligned. */
function Line({
  children,
  label,
  tone = "",
}: {
  children: ReactNode;
  label: ReactNode;
  tone?: string;
}) {
  return (
    <div className="returnsLine">
      <dt>{label}</dt>
      <dd className={tone}>{children}</dd>
    </div>
  );
}

export function ReturnsPanel({
  benchmark,
  privacyMode,
  view,
}: {
  /** The comparison with the tracked index, when there is one: it goes beside the TWR. */
  benchmark?: ReactNode;
  privacyMode: boolean;
  view: HoldingReturnsView;
}) {
  const caveats =
    view.caveats.length > 0 ? (
      <ul className="returnsCaveats">
        {view.caveats.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    ) : null;

  // An asset that revalues but does not trade has one honest measure (ADR 0040,
  // #562): there is no money-vs-fund question to face.
  if (view.kind === "appreciating") {
    return (
      <section aria-label="Rentabilidad" className="returnsPanel">
        <dl className="returnsLines">
          <Line label="Revalorización" tone={signClass(view.totalGain.amountMinor)}>
            {signedMoney(view.totalGain, privacyMode)} ·{" "}
            {formatMeasurePct(view.totalReturnRatio)}
          </Line>
        </dl>
        {caveats}
        {benchmark}
      </section>
    );
  }

  const irrRate = view.irr?.rate ?? null;
  const irrWhy = irrUnavailableReason(view.irr?.reason ?? null);

  const twr = view.twr;
  const twrAnnual = twr?.annualized && twr.annualizedRate !== null;
  const twrHeadline = twrAnnual ? twr.annualizedRate : (twr?.rate ?? null);
  const twrSince = twr?.startDate ? formatDateKeyEs(twr.startDate) : null;
  // No monthly closes at all is the same absence as too few of them.
  const twrWhy =
    twrUnavailableReason(twr?.reason ?? null) ??
    twrUnavailableReason("insufficient_monthly_closes");

  return (
    <section aria-label="Rentabilidad" className="returnsPanel">
      <div className="returnsFaceoff">
        <section aria-labelledby="returns-money-title" className="returnsSide">
          <h3 id="returns-money-title">
            Tu dinero{" "}
            <abbr title="Tasa interna de retorno: pondera cada euro por el tiempo que lleva dentro">
              TIR
            </abbr>
          </h3>
          <Headline
            caption={
              irrRate === null
                ? `Sin TIR: ${irrWhy ?? "no se ha podido calcular"}.`
                : "Cuenta cuándo pusiste y cuándo sacaste cada euro."
            }
            rate={irrRate}
            span="al año"
          />
          <dl className="returnsLines">
            <Line
              label={view.annualized ? "Ganancia total" : "Ganancia total (no anual)"}
              tone={signClass(view.totalGain.amountMinor)}
            >
              {signedMoney(view.totalGain, privacyMode)} ·{" "}
              {formatMeasurePct(view.totalReturnRatio)}
            </Line>
            {view.annualized && view.cagr !== null ? (
              <Line label="Al año, sin ponderar (CAGR)">{formatRatioPct(view.cagr)}</Line>
            ) : null}
            {view.realizedPnl ? (
              <Line
                label="Realizada (lo ya vendido)"
                tone={signClass(view.realizedPnl.amountMinor)}
              >
                {signedMoney(view.realizedPnl, privacyMode)}
              </Line>
            ) : null}
            {/* The mark takes the figure's own slot (#1505). Leaving the line out
                would read as «this holding has no latent gain»; the point is that
                nobody knows, and this line is where the reader looks for it. */}
            {view.costBasisGrade === "value_only" ? (
              <Line label="Latente (lo que sigue invertido)" tone="contextUnknown">
                {costBasisGradeMark("value_only")}
              </Line>
            ) : view.unrealizedPnl ? (
              <Line
                label="Latente (lo que sigue invertido)"
                tone={signClass(view.unrealizedPnl.amountMinor)}
              >
                {signedMoney(view.unrealizedPnl, privacyMode)}
              </Line>
            ) : null}
          </dl>
        </section>

        <section aria-labelledby="returns-fund-title" className="returnsSide">
          <h3 id="returns-fund-title">
            El fondo{" "}
            <abbr title="Rentabilidad ponderada por tiempo: descuenta cuándo aportaste">
              TWR
            </abbr>
          </h3>
          <Headline
            caption={
              twrHeadline === null
                ? `Sin TWR: ${twrWhy}.`
                : "Lo que hizo el producto, aportaras cuando aportaras: lo que se compara con un índice."
            }
            rate={twrHeadline}
            span={twrAnnual ? "al año" : "en total, no anual"}
          />
          {twrHeadline !== null && twrSince ? (
            <dl className="returnsLines">
              {twrAnnual ? (
                <Line label={`Total desde el ${twrSince}`}>
                  {formatMeasurePct(twr?.rate ?? null)}
                </Line>
              ) : (
                <Line label="Medida desde el">{twrSince}</Line>
              )}
            </dl>
          ) : null}
          {benchmark}
        </section>
      </div>
      {caveats}
    </section>
  );
}
