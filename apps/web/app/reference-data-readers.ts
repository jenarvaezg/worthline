import type { ExposureProfileCatalog } from "@worthline/db";
import type {
  ExposureCatalogAvailability,
  ExposureCatalogReader,
  ReferenceDataReaders,
  ReferenceDataUnavailableReason,
} from "@worthline/domain";

/**
 * The slice of the control plane the reference readers read. Only the exposure
 * catalog since #1750: benchmark series go through `read-benchmark-prices.ts`.
 */
export type ReferenceDataStore = Pick<
  ExposureProfileCatalog,
  "readGlobalExposureProfiles"
>;

function unavailableCatalog(
  reason: ReferenceDataUnavailableReason,
): ExposureCatalogAvailability {
  return { status: "unavailable", reason };
}

export function createFixedExposureCatalogReader(
  availability: ExposureCatalogAvailability,
): ExposureCatalogReader {
  return {
    readCatalog: async () => availability,
  };
}

export function createUnavailableReferenceDataReaders(
  reason: ReferenceDataUnavailableReason,
): ReferenceDataReaders {
  return {
    exposureCatalogReader: createFixedExposureCatalogReader(unavailableCatalog(reason)),
  };
}

export function createControlPlaneReferenceDataReaders(
  store: ReferenceDataStore,
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

  return { exposureCatalogReader };
}
