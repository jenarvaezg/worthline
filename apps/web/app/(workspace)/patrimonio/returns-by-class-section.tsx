import {
  formatMeasurePct,
  signClass,
  twrUnavailableTitle,
} from "@web/_components/returns-format";
import type { AssetClassReturnsViewResult, TwrReason } from "@worthline/domain";
import { ATTRIBUTED_ONLY_NOTICE, formatMoneyMinorPrivacy } from "@worthline/domain";

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
 * dash, never a fabricated number — and that em dash says on hover WHY the measure
 * is missing, so an absent figure reads as a signal and not as a glitch (#1457).
 *
 * A class the workspace no longer holds (`closed`, #1456) does not compete for the
 * reader's attention with the ones that sustain the patrimonio: it folds away
 * behind a native `<details>` — the same gesture the closed positions use in the
 * balance board — because the footer announces the split is made with TODAY's
 * weights, and a class with no value today takes no part in it. Folded, never
 * dropped: its episode was real and stays one click away.
 *
 * And a class that owns no product of its own (`attributedOnly`, #1458) does not
 * print a rate at all: «Efectivo +10,4%» was the mixed pension plans' return
 * wearing the cash sleeve's name, and a reader had no reason to doubt it under a
 * subtitle that promised measurement. Its value and weight stay — those are a
 * split of euros, which the attribution does know — and the three measures read
 * as em dashes that say why, with the word «atribuida» beside the label and the
 * full sentence in the footer, because a phone has no hover.
 */
/** The hover text behind a missing TWR: the reason, never just its absence. */
function twrWhy(reason: TwrReason | null): string {
  return twrUnavailableTitle(reason, "esta clase");
}

/** One class's row: its label, attributed value and weight, plus the three measures. */
function ClassRow({
  entry,
  weight,
  privacyMode,
}: {
  entry: AssetClassReturnsViewResult["classes"][number];
  weight: string;
  privacyMode: boolean;
}) {
  // A borrowed class's em dashes all say the SAME thing, and it is not the TWR
  // reason: «no hay TWR» would describe a measurement that failed, when what
  // happened is that there was never a figure of this class's to measure.
  const borrowedWhy = entry.attributedOnly ? ATTRIBUTED_ONLY_NOTICE : null;
  const borrowedTitle = borrowedWhy === null ? {} : { title: borrowedWhy };
  return (
    <li className="returnsClassRow">
      <div className="returnsClassHead">
        <span className="returnsClassLabel">
          {assetClassLabel(entry.key)}
          {borrowedWhy === null ? null : (
            <span className="returnsClassAttributed" title={borrowedWhy}>
              atribuida
            </span>
          )}
        </span>
        <b>{formatMoneyMinorPrivacy(entry.value, privacyMode)}</b>
        <span className="returnsClassShare">{formatExposureWeight(weight)}</span>
      </div>
      <dl className="returnsClassMeasures">
        <div>
          <dt>Ganancia</dt>
          <dd className={signClass(entry.view.totalReturnRatio)} {...borrowedTitle}>
            {formatMeasurePct(entry.view.totalReturnRatio)}
          </dd>
        </div>
        <div>
          <dt>IRR</dt>
          <dd {...borrowedTitle}>{formatMeasurePct(entry.view.irr?.rate ?? null)}</dd>
        </div>
        <div>
          <dt>TWR</dt>
          <dd
            {...(borrowedWhy !== null
              ? borrowedTitle
              : entry.view.twr?.rate == null
                ? { title: twrWhy(entry.view.twr?.reason ?? null) }
                : {})}
          >
            {formatMeasurePct(entry.view.twr?.rate ?? null)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export default function ReturnsByClassSection({
  returns,
  privacyMode,
}: {
  returns: AssetClassReturnsViewResult;
  privacyMode: boolean;
}) {
  // The list ranks classes by their weight TODAY, so only the live ones are in it
  // (#1456); the closed ones all read 0 €, so the denominator is the same either way.
  const live = returns.classes.filter((entry) => !entry.closed);
  const closed = returns.classes.filter((entry) => entry.closed);
  const totalMinor = live.reduce((sum, entry) => sum + entry.value.amountMinor, 0);
  const weightOf = (amountMinor: number): string =>
    totalMinor > 0 ? (amountMinor / totalMinor).toString() : "0";

  return (
    <section
      className="returnsByClassSection section"
      aria-label="Rentabilidad por clase de activo"
    >
      <div className="panelHeader">
        <h2>Rentabilidad por clase</h2>
        <span>Reparto del resultado entre las clases del perfil</span>
      </div>

      {live.length === 0 ? (
        <p className="returnsClassEmpty">Ninguna clase con valor hoy.</p>
      ) : (
        <ul className="returnsClassRows">
          {live.map((entry) => (
            <ClassRow
              entry={entry}
              key={entry.key}
              privacyMode={privacyMode}
              weight={weightOf(entry.value.amountMinor)}
            />
          ))}
        </ul>
      )}

      {closed.length > 0 ? (
        <details suppressHydrationWarning className="returnsClassClosed">
          <summary>Clases cerradas ({closed.length})</summary>
          <ul className="returnsClassRows">
            {closed.map((entry) => (
              <ClassRow
                entry={entry}
                key={entry.key}
                privacyMode={privacyMode}
                weight={weightOf(entry.value.amountMinor)}
              />
            ))}
          </ul>
        </details>
      ) : null}

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

      {returns.classes.some((entry) => entry.attributedOnly) ? (
        <p className="returnsByClassCaveat">
          <b>Atribuida</b> — {ATTRIBUTED_ONLY_NOTICE}
        </p>
      ) : null}
    </section>
  );
}
