import type { GlobalExposureProfile } from "./global-exposure-profile";

/** Why global reference data could not be read (#943). */
export type ReferenceDataUnavailableReason = "not_configured" | "read_failed";

export type ExposureCatalogAvailability =
  | { status: "available"; profiles: readonly GlobalExposureProfile[] }
  | { status: "unavailable"; reason: ReferenceDataUnavailableReason };

export interface BenchmarkSeriesPricePoint {
  seriesId: string;
  dateKey: string;
  value: string;
}

export type BenchmarkSeriesAvailability =
  | { status: "available"; prices: readonly BenchmarkSeriesPricePoint[] }
  | { status: "unavailable"; reason: ReferenceDataUnavailableReason };

/** Read port for the global exposure-profile catalog (PRD #711 S2 / #943). */
export interface ExposureCatalogReader {
  readCatalog(): Promise<ExposureCatalogAvailability>;
}

/** Read port for benchmark series cached in the control plane (ADR 0060 / #943). */
export interface BenchmarkSeriesReader {
  readSeries(seriesId: string): Promise<BenchmarkSeriesAvailability>;
}

export interface ReferenceDataReaders {
  exposureCatalogReader: ExposureCatalogReader;
  benchmarkSeriesReader: BenchmarkSeriesReader;
}
