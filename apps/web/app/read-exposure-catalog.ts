import type { BenchmarkPriceCache, ExposureProfileCatalog } from "@worthline/db";
import type { ExposureCatalogAvailability, ExposureProfile } from "@worthline/domain";
import { exposureProfileLookthroughMap } from "@worthline/domain";

import { withOptionalControlPlaneStore } from "./control-plane-store";
import { createControlPlaneReferenceDataReaders } from "./reference-data-readers";

/**
 * Global exposure-profile catalog reader (PRD #711 S3, boundary #943). Reads the
 * S2 port ({@link ExposureCatalogReader}) over a freshly-opened control-plane
 * connection and returns the typed 3-state availability — never a bare `[]`.
 *
 * Deliberately NOT wrapped in `unstable_cache` (unlike benchmark series): the
 * catalog is admin-curated and must be read-after-write, so a workspace read must
 * never serve a stale cross-request snapshot. No control-plane URL is
 * `not_configured` (not an empty catalog); an open/read failure degrades to
 * `read_failed`. The connection is opened and always closed by
 * {@link withOptionalControlPlaneStore} (#1694).
 */
export async function readExposureCatalogFromControlPlane(): Promise<ExposureCatalogAvailability> {
  try {
    const availability = await withOptionalControlPlaneStore<
      ExposureCatalogAvailability,
      Pick<ExposureProfileCatalog, "readGlobalExposureProfiles"> &
        Pick<BenchmarkPriceCache, "readBenchmarkPrices">
    >(async (store) => {
      const readers = createControlPlaneReferenceDataReaders(store);
      return await readers.exposureCatalogReader.readCatalog();
    });
    return availability ?? { status: "unavailable", reason: "not_configured" };
  } catch {
    return { status: "unavailable", reason: "read_failed" };
  }
}

/**
 * The global catalog as look-through domain profiles keyed by `isin ?? providerSymbol`
 * (PRD #711 S3) — the drop-in replacement for the retired per-workspace
 * `store.exposureProfiles.readExposureProfiles()` in RSC surfaces. Degrades to an
 * empty list when the catalog is unavailable (net worth still resolves; the
 * look-through simply classifies nothing).
 */
export async function readExposureProfilesFromCatalog(): Promise<ExposureProfile[]> {
  const availability = await readExposureCatalogFromControlPlane();
  if (availability.status !== "available") {
    return [];
  }
  return [...exposureProfileLookthroughMap(availability.profiles).values()];
}
