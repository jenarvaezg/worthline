import type { ControlPlaneStore } from "@worthline/db";
import type {
  BenchmarkSeriesAvailability,
  BenchmarkSeriesReader,
  ExposureCatalogAvailability,
  ExposureCatalogReader,
  ReferenceDataReaders,
  ReferenceDataUnavailableReason,
} from "@worthline/domain";

function unavailableCatalog(
  reason: ReferenceDataUnavailableReason,
): ExposureCatalogAvailability {
  return { status: "unavailable", reason };
}

function unavailableSeries(
  reason: ReferenceDataUnavailableReason,
): BenchmarkSeriesAvailability {
  return { status: "unavailable", reason };
}

export function createFixedExposureCatalogReader(
  availability: ExposureCatalogAvailability,
): ExposureCatalogReader {
  return {
    readCatalog: async () => availability,
  };
}

export function createFixedBenchmarkSeriesReader(
  read: (seriesId: string) => Promise<BenchmarkSeriesAvailability>,
): BenchmarkSeriesReader {
  return {
    readSeries: read,
  };
}

export function createUnavailableReferenceDataReaders(
  reason: ReferenceDataUnavailableReason,
): ReferenceDataReaders {
  const catalog = unavailableCatalog(reason);
  const series = unavailableSeries(reason);
  return {
    exposureCatalogReader: createFixedExposureCatalogReader(catalog),
    benchmarkSeriesReader: createFixedBenchmarkSeriesReader(async () => series),
  };
}

export function createControlPlaneReferenceDataReaders(
  store: ControlPlaneStore,
): ReferenceDataReaders {
  let catalogSnapshot: ExposureCatalogAvailability | undefined;
  let catalogLoadPromise: Promise<ExposureCatalogAvailability> | undefined;

  const exposureCatalogReader: ExposureCatalogReader = {
    async readCatalog() {
      if (catalogSnapshot) {
        return catalogSnapshot;
      }
      if (!catalogLoadPromise) {
        catalogLoadPromise = (async () => {
          try {
            const profiles = await store.readGlobalExposureProfiles();
            catalogSnapshot = { status: "available", profiles };
            return catalogSnapshot;
          } catch {
            return unavailableCatalog("read_failed");
          }
        })();
      }
      return catalogLoadPromise;
    },
  };

  const benchmarkSeriesReader: BenchmarkSeriesReader = {
    async readSeries(seriesId) {
      try {
        const prices = await store.readBenchmarkPrices(seriesId);
        return { status: "available", prices };
      } catch {
        return unavailableSeries("read_failed");
      }
    },
  };

  return { exposureCatalogReader, benchmarkSeriesReader };
}
