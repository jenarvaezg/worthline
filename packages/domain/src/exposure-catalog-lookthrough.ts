import type { ExposureProfile } from "./exposure-lookthrough";
import type { GlobalExposureProfile } from "./global-exposure-profile";

/**
 * Adapt global-catalog profiles (PRD #711, ADR 0058) into the look-through's
 * per-security map. The map is keyed by `isin ?? providerSymbol` — the exact key
 * a holding resolves with in {@link lookThroughExposure} / {@link resolveAssetClassBreakdown}
 * (an ISIN-identity row keys on its ISIN, a provider-identity row on its raw
 * `providerSymbol`, never the `p:provider:symbol` composite the catalog stores
 * internally). The catalog is now the source of truth; the provenance fields the
 * aggregation never reads default to `source:"user"` / `declaredAt:null`, and a
 * profile hedged to any currency suppresses currency risk (`hedged:true`).
 */
export function exposureProfileLookthroughMap(
  profiles: readonly GlobalExposureProfile[],
): Map<string, ExposureProfile> {
  const map = new Map<string, ExposureProfile>();
  for (const profile of profiles) {
    const key =
      profile.identity.kind === "isin"
        ? profile.identity.isin
        : profile.identity.providerSymbol;
    map.set(key, {
      key,
      source: "user",
      declaredAt: null,
      trackedIndex: profile.trackedIndex,
      ter: profile.ter,
      hedged: profile.hedgedToCurrency !== null,
      breakdowns: profile.breakdowns,
    });
  }
  return map;
}
