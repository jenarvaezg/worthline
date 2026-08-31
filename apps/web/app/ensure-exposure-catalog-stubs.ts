import type { ExposureProfileCatalog } from "@worthline/db";
import {
  deriveExposureCatalogIdentity,
  type ExposureCatalogIdentitySource,
  type GlobalExposureProfileIdentity,
  globalExposureProfileIdentityKey,
} from "@worthline/domain";

import { withOptionalControlPlaneStore } from "./control-plane-store";

/**
 * A holding to register in the global exposure catalog: its identity fields plus
 * the human name the admin should see (#1097).
 */
export interface ExposureCatalogStubCandidate extends ExposureCatalogIdentitySource {
  displayName?: string | null;
}

/**
 * Register the empty catalog rows for a batch of just-persisted holdings — the
 * seam that makes "the catalog row is born with the holding" (#1097, ADR 0058
 * amendment). Best-effort by design: it derives each holding's catalog identity,
 * dedupes, and registers a stub, but it is wrapped so it can NEVER block or fail
 * the holding write that triggered it.
 *
 * - Non-market holdings (cash/property/crypto/coins) derive to no identity and
 *   are silently skipped — which is why connected sources (crypto/coins only
 *   today) register nothing.
 * - No control plane configured → no-op (dev without a catalog still works).
 * - A control-plane open/write failure is swallowed: the stub will be created on
 *   the next write or sync touching the same identity (registration is idempotent).
 */
export async function ensureExposureCatalogStubs(
  candidates: readonly ExposureCatalogStubCandidate[],
): Promise<void> {
  const byKey = new Map<
    string,
    { identity: GlobalExposureProfileIdentity; displayName: string | null }
  >();
  for (const candidate of candidates) {
    const identity = deriveExposureCatalogIdentity(candidate);
    if (!identity) {
      continue;
    }
    const key = globalExposureProfileIdentityKey(identity);
    if (!byKey.has(key)) {
      byKey.set(key, { displayName: candidate.displayName ?? null, identity });
    }
  }
  if (byKey.size === 0) {
    return;
  }

  try {
    await withOptionalControlPlaneStore<
      void,
      Pick<ExposureProfileCatalog, "ensureGlobalExposureProfileStub">
    >(async (store) => {
      for (const { identity, displayName } of byKey.values()) {
        try {
          await store.ensureGlobalExposureProfileStub(identity, displayName);
        } catch {
          // One identity failing must not abort the rest, nor the caller's write.
        }
      }
    });
  } catch {
    // An open failure is swallowed too: the next write retries the registration.
  }
}
