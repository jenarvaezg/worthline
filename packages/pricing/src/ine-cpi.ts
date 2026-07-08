export const INE_SPANISH_CPI_TABLE_ID = "24077";

export interface BenchmarkPricePoint {
  dateKey: string;
  value: string;
}

interface IneDataPoint {
  Anyo?: unknown;
  FK_Periodo?: unknown;
  Valor?: unknown;
}

interface IneSeries {
  Data?: IneDataPoint[];
}

export async function fetchSpanishCpi(
  options: {
    tableId?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<BenchmarkPricePoint[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tableId = options.tableId ?? INE_SPANISH_CPI_TABLE_ID;
  const res = await fetchImpl(
    `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${tableId}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`INE responded with ${res.status}`);

  const series = (await res.json()) as IneSeries[];
  const rows = series[0]?.Data ?? [];
  return rows
    .flatMap((row) => {
      const year = Number(row.Anyo);
      const month = Number(row.FK_Periodo);
      const value = Number(row.Valor);
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(value)) {
        return [];
      }
      return [
        {
          dateKey: `${year}-${String(month).padStart(2, "0")}-01`,
          value: String(row.Valor),
        },
      ];
    })
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}
