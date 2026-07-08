import type {
  HoldingBenchmarkComparisonResult,
  HoldingBenchmarkUnavailableReason,
} from "@worthline/domain";

import { formatRatioPct } from "@web/_components/returns-format";

function formatPpPerYear(rate: number): string {
  const pp = rate * 100;
  const sign = pp > 0 ? "+" : pp < 0 ? "−" : "";
  return `${sign}${Math.abs(pp).toFixed(1).replace(".", ",")} pp/año`;
}

function formatHundred(value: number): string {
  return `${Math.round(value).toLocaleString("es-ES")} €`;
}

function formatMonth(dateKey: string): string {
  const [year, month] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  })
    .format(new Date(Date.UTC(year!, month! - 1, 1)))
    .replace(".", "");
}

function emptyMessage(reason: HoldingBenchmarkUnavailableReason): string {
  switch (reason) {
    case "no_tracked_index":
      return "Sin índice de referencia asignado.";
    case "benchmark_unmapped":
      return "El índice no está en el catálogo.";
    case "twr_unavailable":
      return "La TWR necesita al menos dos cierres mensuales.";
    case "zero_start_value":
      return "La comparación necesita un valor inicial positivo.";
    default:
      return "Sin datos del índice todavía.";
  }
}

export default function HoldingBenchmarkComparisonCard({
  result,
  trackedIndex,
}: {
  result: HoldingBenchmarkComparisonResult;
  trackedIndex: string;
}) {
  const ariaLabel = `Comparación con ${trackedIndex}`;

  if (!result.comparison) {
    return (
      <div className="benchmarkCard benchmarkEmpty" aria-label={ariaLabel}>
        <span>vs {trackedIndex}</span>
        <p>{emptyMessage(result.unavailableReason)}</p>
      </div>
    );
  }

  const { comparison } = result;
  const sign = comparison.realAnnualGrowth >= 0 ? "pos" : "neg";

  return (
    <div className="benchmarkCard" aria-label={ariaLabel}>
      <div className="benchmarkVerdict">
        <span>vs {trackedIndex}</span>
        <strong className={sign}>{formatPpPerYear(comparison.realAnnualGrowth)}</strong>
        <small>Desde {formatMonth(comparison.sinceDate)} · TWR sin aportaciones</small>
      </div>
      <dl className="benchmarkStats">
        <div>
          <dt>TWR/año</dt>
          <dd>{formatRatioPct(comparison.subjectAnnualGrowth)}</dd>
        </div>
        <div>
          <dt>Índice/año</dt>
          <dd>{formatRatioPct(comparison.benchmarkAnnualGrowth)}</dd>
        </div>
        <div>
          <dt>Exceso acumulado</dt>
          <dd>{formatRatioPct(comparison.realGrowth)}</dd>
        </div>
      </dl>
      <p className="benchmarkHundred">
        Crecimiento de 100 €: <b>100 €</b>
        <span aria-hidden="true">→</span>
        <b>{formatHundred(100 * (1 + comparison.realGrowth))}</b> vs índice
      </p>
      {comparison.coverageNote ? (
        <p className="benchmarkCoverage">{comparison.coverageNote}</p>
      ) : null}
    </div>
  );
}
