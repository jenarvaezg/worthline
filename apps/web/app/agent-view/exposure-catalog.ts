import type {
  ExposureCatalogAvailability,
  ExposureProfile,
  ReferenceDataUnavailableReason,
} from "@worthline/domain";
import { exposureProfileLookthroughMap } from "@worthline/domain";

/**
 * The global exposure catalog as an agent-view consumer sees it after resolution
 * (PRD #711 S3): either the look-through profile map keyed by `isin ?? providerSymbol`,
 * or a typed unavailability the consumer must degrade against — never a silent
 * empty map. A distinct `unavailable` state is what lets holding detail report
 * `catalog_unavailable` instead of `profile_missing`, and the benchmark lens
 * `catalog_unavailable` instead of `no_tracked_index`.
 */
export type ResolvedExposureCatalog =
  | { status: "available"; profiles: ReadonlyMap<string, ExposureProfile> }
  | { status: "unavailable"; reason: ReferenceDataUnavailableReason };

/** Injected reader signature — resolved once per request and inherited by MCP/chat. */
export type ReadExposureCatalog = () => Promise<ExposureCatalogAvailability>;

/** Adapt the S2 port's availability into the resolved look-through view. */
export function resolveExposureCatalog(
  availability: ExposureCatalogAvailability,
): ResolvedExposureCatalog {
  if (availability.status === "unavailable") {
    return { status: "unavailable", reason: availability.reason };
  }
  return {
    status: "available",
    profiles: exposureProfileLookthroughMap(availability.profiles),
  };
}

/** The profile map for the aggregation, empty when the catalog is unavailable. */
export function catalogProfileMap(
  resolved: ResolvedExposureCatalog,
): ReadonlyMap<string, ExposureProfile> {
  return resolved.status === "available" ? resolved.profiles : new Map();
}
