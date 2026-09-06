import type { GlobalExposureProfile } from "./global-exposure-profile";

/** Why global reference data could not be read (#943). */
export type ReferenceDataUnavailableReason = "not_configured" | "read_failed";

export type ExposureCatalogAvailability =
  | { status: "available"; profiles: readonly GlobalExposureProfile[] }
  | { status: "unavailable"; reason: ReferenceDataUnavailableReason };

/** Read port for the global exposure-profile catalog (PRD #711 S2 / #943). */
export interface ExposureCatalogReader {
  readCatalog(): Promise<ExposureCatalogAvailability>;
}

/**
 * The reference-data read ports assembled over one control-plane connection
 * (#943). Benchmark series are not a port here: they are a present-time lens
 * read straight from the control-plane cache (ADR 0060, #1750).
 */
export interface ReferenceDataReaders {
  exposureCatalogReader: ExposureCatalogReader;
}
