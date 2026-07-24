import { errorRedirectUrl, mapDomainViolation, preserveFields } from "@web/intake";
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
  "liquidityTier",
  "isPrimaryResidence",
  "ownershipPreset",
];

/** Base page URL for actions in this section — the patrimonio list. */
export function baseUrl(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/patrimonio";
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
export function editAssetErrorUrl(
  id: string,
  formData: FormData,
  message: string,
): string {
  return errorRedirectUrl(`/patrimonio/${id}/editar`, {
    formId: "edit",
    message,
    values: preserveFields(
      formData,
      [...EDIT_ASSET_FIELDS, "type", "associatedAssetId"],
      ["owner_"],
    ),
  });
}

/** The editar page URL for a given holding — where every housing action returns. */
export function editUrl(id: string): string {
  return `/patrimonio/${id}/editar`;
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
