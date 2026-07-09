import { formatRatioPct } from "@web/_components/returns-format";
import type {
  BenchmarkComparisonResult,
  BenchmarkComparisonUnavailableReason,
} from "@worthline/domain";

function formatPpPerYear(rate: number): string {
  const pp = rate * 100;
  const sign = pp > 0 ? "+" : pp < 0 ? "−" : "";
  return `${sign}${Math.abs(pp).toFixed(1).replace(".", ",")} pp/año real`;
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

function emptyMessage(reason: BenchmarkComparisonUnavailableReason): string {
  return reason === "zero_start_value"
    ? "La comparación con IPC necesita un patrimonio inicial positivo."
    : "Sin datos de IPC todavía.";
}

export default function BenchmarkComparisonCard({
  result,
}: {
  result: BenchmarkComparisonResult;
}) {
  if (!result.comparison) {
    return (
      <div className="benchmarkCard benchmarkEmpty" aria-label="Comparación con IPC">
        <span>Patrimonio real</span>
        <p>{emptyMessage(result.unavailableReason)}</p>
      </div>
    );
  }

  const { comparison } = result;
  const sign = comparison.realAnnualGrowth >= 0 ? "pos" : "neg";

  return (
    <div className="benchmarkCard" aria-label="Comparación con IPC">
      <div className="benchmarkVerdict">
        <span>Patrimonio real</span>
        <strong className={sign}>{formatPpPerYear(comparison.realAnnualGrowth)}</strong>
        <small>Desde {formatMonth(comparison.sinceDate)} · incluye aportaciones</small>
      </div>
      <dl className="benchmarkStats">
        <div>
          <dt>Patrimonio/año</dt>
          <dd>{formatRatioPct(comparison.subjectAnnualGrowth)}</dd>
        </div>
        <div>
          <dt>IPC/año</dt>
          <dd>{formatRatioPct(comparison.benchmarkAnnualGrowth)}</dd>
        </div>
        <div>
          <dt>Real acumulado</dt>
          <dd>{formatRatioPct(comparison.realGrowth)}</dd>
        </div>
      </dl>
      <p className="benchmarkHundred">
        Crecimiento de 100 €: <b>100 €</b>
        <span aria-hidden="true">→</span>
        <b>{formatHundred(100 * (1 + comparison.realGrowth))}</b> reales
      </p>
    </div>
  );
}
