"use server";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";
import type {
  GlobalExposureProfile,
  GlobalExposureProfileBreakdowns,
  RawGlobalExposureProfileIdentityInput,
} from "@worthline/domain";
import {
  globalExposureProfileIdentityKey,
  resolveGlobalExposureProfileIdentity,
} from "@worthline/domain";

/**
 * Catalog CRUD server actions (PRD #711 S4, decision #941, guard #938 eje 1).
 *
 * Each action re-runs `guardAdmin()` as its FIRST line (defense in depth, ADR
 * 0030): a direct POST with a non-admin / logged-out / demo session — or with
 * `WORTHLINE_ADMIN_EMAIL` empty — `notFound()`s byte-identically to an unknown
 * URL, before any FormData is read and before any write is attempted. The
 * page-level gate is never trusted to have run.
 *
 * Domain contract violations (#940) and control-plane failures are caught and
 * returned as a typed `{ status: "error" }` so the edit panel can surface the
 * message inline without losing the admin's typed draft — never a raw 500. The
 * store returns the just-persisted record, so the client reflects it
 * read-after-write (#943) without a stale cross-request snapshot.
 */
export type CatalogActionResult =
  | { status: "idle" }
  | { status: "saved"; profile: GlobalExposureProfile; previousKey: string | null }
  | { status: "deleted"; identityKey: string }
  | { status: "error"; message: string };

function readIdentity(
  formData: FormData,
  prefix = "",
): RawGlobalExposureProfileIdentityInput {
  return {
    isin: String(formData.get(`${prefix}isin`) ?? ""),
    priceProvider: String(formData.get(`${prefix}priceProvider`) ?? ""),
    providerSymbol: String(formData.get(`${prefix}providerSymbol`) ?? ""),
  };
}

/**
 * Parse the breakdowns JSON the client island builds from its draft, dropping
 * blank weights so an empty input never reaches the domain's `new Big("")`.
 * Malformed JSON throws, surfaced as a friendly error by the caller.
 */
function readBreakdowns(formData: FormData): GlobalExposureProfileBreakdowns {
  const raw = String(formData.get("breakdowns") ?? "").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  const breakdowns: GlobalExposureProfileBreakdowns = {};
  for (const dimension of ["geography", "currency", "assetClass", "sector"] as const) {
    const source = parsed[dimension];
    if (!source || typeof source !== "object") {
      continue;
    }
    const cleaned: Record<string, string> = {};
    for (const [bucket, weight] of Object.entries(source)) {
      const value = String(weight ?? "").trim();
      if (value) {
        cleaned[bucket] = value;
      }
    }
    if (Object.keys(cleaned).length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: dimension is a known key of the breakdowns record.
      (breakdowns as any)[dimension] = cleaned;
    }
  }
  return breakdowns;
}

function readContent(formData: FormData) {
  return {
    displayName: String(formData.get("displayName") ?? ""),
    breakdowns: readBreakdowns(formData),
    ter: String(formData.get("ter") ?? "") as GlobalExposureProfile["ter"],
    trackedIndex: String(formData.get("trackedIndex") ?? ""),
    hedgedToCurrency: String(formData.get("hedgedToCurrency") ?? ""),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "No se pudo completar la operación sobre el catálogo.";
}

/**
 * Create a new profile or replace an existing profile's content. `mode`
 * distinguishes the two: create fails if the identity already exists; update
 * fails if it does not. Identity is only editable in a create (a new draft);
 * an existing profile's identity changes exclusively through rekey.
 */
export async function saveCatalogProfileAction(
  _prev: CatalogActionResult,
  formData: FormData,
): Promise<CatalogActionResult> {
  await guardAdmin();

  const mode = String(formData.get("mode") ?? "");
  try {
    const content = readContent(formData);
    const identity = readIdentity(formData);
    const profile = await withControlPlaneStore((store) =>
      mode === "update"
        ? store.updateGlobalExposureProfile(identity, content)
        : store.createGlobalExposureProfile({ ...content, identity }),
    );
    return { status: "saved", profile, previousKey: null };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Rekey a profile's identity — a gesture separate from create/update (#941).
 * `createdAt` is preserved by the store; a collision with an existing identity
 * is rejected. The old key is returned so the client can move its selection.
 */
export async function rekeyCatalogProfileAction(
  _prev: CatalogActionResult,
  formData: FormData,
): Promise<CatalogActionResult> {
  await guardAdmin();

  try {
    const from = readIdentity(formData, "from-");
    const to = readIdentity(formData, "to-");
    const previousKey = globalExposureProfileIdentityKey(
      resolveGlobalExposureProfileIdentity(from),
    );
    const profile = await withControlPlaneStore((store) =>
      store.rekeyGlobalExposureProfile(from, to),
    );
    return { status: "saved", profile, previousKey };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/** Delete a profile (physical, post-confirmation in the UI). Idempotent in the store. */
export async function deleteCatalogProfileAction(
  _prev: CatalogActionResult,
  formData: FormData,
): Promise<CatalogActionResult> {
  await guardAdmin();

  try {
    const identity = readIdentity(formData);
    const identityKey = globalExposureProfileIdentityKey(
      resolveGlobalExposureProfileIdentity(identity),
    );
    await withControlPlaneStore((store) => store.deleteGlobalExposureProfile(identity));
    return { status: "deleted", identityKey };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
