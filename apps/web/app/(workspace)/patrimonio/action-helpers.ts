import { holdingPublicIdOf, readHoldingPublicIdIndex } from "@web/holding-route";
import {
  errorRedirectUrl,
  isLocalRedirectPath,
  mapDomainViolation,
  preserveFields,
} from "@web/intake";
import { type WorthlineStore } from "@web/store";
import { type OwnershipSplitCommandResult } from "@worthline/db";

/**
 * Shared, non-async helpers for the /patrimonio server actions. These live
 * outside the `"use server"` concern files (which may export only async
 * functions) so the action modules can import them.
 */

export const EDIT_ASSET_FIELDS = [
  "name",
  "type",
  // #1512: a refused correction must round-trip the instrument the user picked,
  // or the select snaps back to the misclassification they came to fix.
  "instrument",
  "liquidityTier",
  "isPrimaryResidence",
  "ownershipPreset",
];

/**
 * Where an action in this section returns: the form's own `currentUrl`, falling
 * back to the patrimonio list.
 *
 * This is the ONLY way a holding action may name its return page (#1318). It
 * used to have a sibling, `editUrl(id)`, that rebuilt the ficha path out of the
 * internal storage id — which is precisely how the internal
 * `asset_…`/`liability_…` vocabulary leaked into the URL bar, and from there
 * into the assistant's `screenContext`. The ficha renders `currentUrl` as its
 * public `wl_hld_…` URL and every one of its forms posts it, so reading it back
 * is both correct and the one place the vocabulary is decided.
 */
export function baseUrl(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/patrimonio";
}

/**
 * Where a form asked its success to come back to, or null for «the board, as
 * always». A ficha form that should keep the person on the ficha posts its own URL
 * as `returnTo` — «Cotiza a mano» beside the price (#1731 review), «Actualizar
 * valor» in the side panel (#1846) — and the success lands there with its notice.
 * Only a path inside the app is followed (`isLocalRedirectPath`, the guard every
 * redirect here runs): anything else, or nothing, falls back to the caller's board
 * destination, which lands on the holding's row as it always did.
 *
 * Kept apart from {@link baseUrl} on purpose: `currentUrl` is where a REFUSAL
 * returns, and a form that never posts `returnTo` keeps the success it had.
 */
export function localReturnTo(formData: FormData): string | null {
  const raw = String(formData.get("returnTo") ?? "").trim();
  return raw !== "" && isLocalRedirectPath(raw) ? raw : null;
}

/**
 * The `formId` of the hand-set value form (#1846): «Actualizar valor», in «Lo
 * básico» or in the ficha's side panel. Its own, not «Lo básico»'s `edit`, so a
 * refusal reopens the form that produced it and prints there, once.
 */
export const VALUE_FORM_ID = "value";

/**
 * The holding's board anchor: its public `wl_hld_…` id, so a mutation's success
 * redirect lands on the row it just changed (`/patrimonio?ok=saved#wl_hld_…`).
 * That destination belongs to the list, which is why `baseUrl` — the form's own
 * page — cannot supply it. The internal id is never a substitute: it is the
 * vocabulary #1318 retired.
 *
 * Undefined when the registry has no row. Every action calling this runs AFTER
 * its write committed, so raising there would turn a successful mutation into a
 * 500 over a scroll position; `successRedirectUrl` simply omits the fragment.
 */
export async function holdingBoardAnchor(
  store: WorthlineStore,
  internalHoldingId: string,
): Promise<string | undefined> {
  return holdingPublicIdOf(await readHoldingPublicIdIndex(store), internalHoldingId);
}

/** A success carrying an optional board anchor — `exactOptionalPropertyTypes`-safe. */
export function boardAnchorResult(anchor: string | undefined): {
  ok: true;
  value?: string;
} {
  return anchor === undefined ? { ok: true } : { ok: true, value: anchor };
}

/** Carry {@link holdingBoardAnchor} on a successful command result. */
export async function withBoardAnchor(
  store: WorthlineStore,
  internalHoldingId: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<{ ok: true; value?: string } | { ok: false; error: string }> {
  return result.ok
    ? boardAnchorResult(await holdingBoardAnchor(store, internalHoldingId))
    : result;
}

export function mapOwnershipSplitCommandResult(
  result: OwnershipSplitCommandResult,
): { ok: true } | { ok: false; error: string } {
  if (result.ok) {
    return { ok: true };
  }
  if ("violation" in result) {
    return { ok: false, error: mapDomainViolation(result.violation) };
  }
  return { ok: false, error: result.error };
}

/** The editar error redirect for `editAssetAction` — keeps its wide preserve set. */
export function editAssetErrorUrl(formData: FormData, message: string): string {
  return errorRedirectUrl(baseUrl(formData), {
    formId: "edit",
    message,
    values: preserveFields(
      formData,
      [...EDIT_ASSET_FIELDS, "type", "associatedAssetId"],
      ["owner_"],
    ),
  });
}

/** Read an asset by id, or null. Shared by the housing actions for the R9 guard. */
export async function findAsset(store: WorthlineStore, id: string) {
  return (await store.assets.readAssets()).find((a) => a.id === id) ?? null;
}

/** Read a liability by id, or null. Shared by the debt actions for the R9 guard. */
export async function findLiability(store: WorthlineStore, id: string) {
  return (await store.liabilities.readLiabilities()).find((l) => l.id === id) ?? null;
}

export type DebtModelGuard = "amortizable" | "anchorable";

/** Guard a debt mutation to liabilities carrying the expected model. */
export async function requireDebtModel(
  store: WorthlineStore,
  id: string,
  expected: DebtModelGuard,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const liability = await findLiability(store, id);

  if (!liability) {
    return { ok: false, error: "No se encontró la deuda." };
  }

  const model = await store.liabilities.readDebtModel(id);

  if (expected === "amortizable" && model !== "amortizable") {
    return {
      ok: false,
      error: "El plan de amortización solo aplica a deudas amortizables.",
    };
  }

  if (expected === "anchorable" && model !== "revolving" && model !== "informal") {
    return {
      ok: false,
      error: "Los saldos solo aplican a deudas revolving o informales.",
    };
  }

  return { ok: true };
}

export function parseAssetType(value: FormDataEntryValue | null) {
  if (value === "real_estate") return "real_estate" as const;
  if (value === "manual") return "manual" as const;
  return "cash" as const;
}

export function parseLiquidityTier(value: FormDataEntryValue | null) {
  if (
    value === "market" ||
    value === "term-locked" ||
    value === "illiquid" ||
    value === "housing"
  ) {
    return value;
  }
  return "cash" as const;
}
