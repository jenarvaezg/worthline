/**
 * Passive-income lens (#658): the selected scope's trailing-12m payouts against
 * declared spending — "how much of my spending do my holdings already pay?".
 * Server-rendered; honest about window and coverage (no annualization, coverage
 * only when spending is known).
 *
 * Its own module since #1700: the page places panels, it does not define them.
 */

import type { PassiveIncomeLens, SpendingDebtServiceCoherence } from "@worthline/domain";
import {
  formatMoneyMinorPrivacy,
  spendingDebtServiceCoverageNote,
} from "@worthline/domain";
import { formatDay } from "./format-day";

export function PassiveIncomePanel({
  lens,
  currency,
  debtServiceCoherence,
  privacyMode,
}: {
  lens: PassiveIncomeLens;
  currency: string;
  /**
   * El careo del gasto declarado contra las cuotas vigentes (#1520). La cobertura
   * compara con un gasto cuyo significado depende de si incluye la hipoteca, así que
   * la tarjeta lo dice — incluido cuando el usuario no lo ha declarado.
   */
  debtServiceCoherence: SpendingDebtServiceCoherence | null;
  privacyMode: boolean;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const debtServiceNote =
    debtServiceCoherence === null
      ? null
      : spendingDebtServiceCoverageNote(debtServiceCoherence, currency, privacyMode);
  const coveragePct =
    lens.coverageRatio != null
      ? `${(lens.coverageRatio * 100).toFixed(1).replace(".", ",")} %`
      : null;

  return (
    <section className="firePanel objetivosPasivaPanel" aria-label="Renta pasiva">
      <div className="panelHeader">
        <h3>Renta pasiva</h3>
        <span>cuánto de tu gasto ya pagan tus activos</span>
      </div>

      {lens.hasPayouts ? (
        <>
          <div className="objetivosPasivaTop">
            <div className="objetivosPasivaFigure">
              {/* Neto como titular (#1463): es de lo que se vive. El bruto no
                  desaparece — baja a la sub-línea, solo cuando difieran. */}
              <span className="objetivosPasivaCap">
                {lens.expensesMinor > 0
                  ? "Cobros netos · últimos 12 meses"
                  : "Cobros · últimos 12 meses"}
              </span>
              <strong className="objetivosPasivaBig">{fmt(lens.netMinor)}</strong>
              {lens.expensesMinor > 0 ? (
                <span className="objetivosPasivaCap">
                  brutos {fmt(lens.totalMinor)} − gastos declarados{" "}
                  {fmt(lens.expensesMinor)}
                </span>
              ) : null}
            </div>
            {coveragePct != null ? (
              <div className="objetivosPasivaFigure objetivosPasivaCoverage">
                <strong className="objetivosPasivaBig">{coveragePct}</strong>
                <span className="objetivosPasivaCap">de tu gasto declarado</span>
              </div>
            ) : null}
          </div>

          {lens.coverageRatio != null ? (
            <div className="objetivosPasivaBar" aria-hidden="true">
              {/* Un neto negativo (gastos > renta) es declarable: la barra se queda a 0. */}
              <i
                style={{
                  width: `${Math.min(100, Math.max(0, lens.coverageRatio * 100))}%`,
                }}
              />
            </div>
          ) : null}

          <p className="objetivosPasivaNote">
            Ventana: {formatDay(lens.windowStartISO)} – {formatDay(lens.windowEndISO)} ·{" "}
            {lens.count} {lens.count === 1 ? "cobro" : "cobros"}
            {lens.annualSpendingMinor != null
              ? ` · cobertura sobre ${fmt(lens.annualSpendingMinor)}/año`
              : " · añade tu gasto en tus supuestos para ver la cobertura"}
            . Suma cobros reales del periodo, sin anualizar los parciales.
          </p>

          {/* Contra QUÉ gasto se mide esa cobertura (#1520). Solo cuando hay cobertura
              que glosar: sin gasto declarado no hay porcentaje del que hablar. */}
          {debtServiceNote && lens.coverageRatio != null ? (
            <p className="objetivosPasivaNote">{debtServiceNote}</p>
          ) : null}
        </>
      ) : (
        <p className="objetivosPasivaEmpty">
          Aún no has registrado cobros (dividendos, intereses o alquileres) en este
          ámbito. Regístralos en la ficha de cada activo para ver cuánto de tu gasto ya
          cubren.
        </p>
      )}
    </section>
  );
}
