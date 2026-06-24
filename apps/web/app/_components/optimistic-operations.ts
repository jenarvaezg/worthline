import { parseMoneyMinor } from "@web/intake-primitives";
import type { InvestmentOperation } from "@worthline/domain";

/**
 * Pure optimistic-merge for the investment operations editor (#521, S5 of #485,
 * interaction-patterns §4/§7). Recording an operation redirects back to the same
 * /patrimonio/[id]/editar page, so the new row can show in the list BEFORE the
 * action resolves; a delete vanishes its row the same way. The redirect settles
 * server truth (or, on the error redirect, reverts the optimistic row + surfaces
 * the error band). Only the operation ROW is faked — it is exactly what the user
 * typed — while the derived units/value/PnL are server-computed and NOT
 * predictable, so they are left to settle (§4). Pure (no React) so the merge
 * unit-tests in the node env while the editor stays a thin `useOptimistic` shell.
 */

/** The operations editor's optimistic-eligible mutations, each tagged by its action. */
export type OperationMutation =
  | { kind: "add"; operation: InvestmentOperation }
  | { kind: "delete"; id: string };

function applyOne(
  list: readonly InvestmentOperation[],
  mutation: OperationMutation,
): InvestmentOperation[] {
  switch (mutation.kind) {
    case "add":
      return [...list, mutation.operation];
    case "delete":
      return list.filter((operation) => operation.id !== mutation.id);
    default:
      return [...list];
  }
}

/**
 * The base list with every pending mutation folded over it in order, as a fresh
 * array (the base is never mutated). The editor sorts for display, so the fold
 * only has to add/remove — order here is irrelevant.
 */
export function applyOperationMutations(
  base: readonly InvestmentOperation[],
  pending: readonly OperationMutation[],
): InvestmentOperation[] {
  return pending.reduce(applyOne, [...base]);
}

/**
 * Build the optimistic operation row from the record form, or null when the
 * required units/price are blank — so a half-filled submit never adds a ghost
 * row (the server rejects it anyway, reverting on its error redirect). The typed
 * units/price strings are shown verbatim (an optimistic display, replaced by the
 * server-normalized values on the redirect); `id` is a client-supplied temporary
 * key, `today` the fallback execution date.
 */
export function parseOperationDraft(
  formData: FormData,
  assetId: string,
  today: string,
  id: string,
): InvestmentOperation | null {
  const units = String(formData.get("units") ?? "").trim();
  const pricePerUnit = String(formData.get("pricePerUnit") ?? "").trim();
  if (!units || !pricePerUnit) {
    return null;
  }
  const kind = formData.get("kind") === "sell" ? "sell" : "buy";
  const executedAt = String(formData.get("executedAt") ?? "").trim() || today;
  const feesMinor = parseMoneyMinor(String(formData.get("fees") ?? "")) ?? 0;

  return {
    id,
    assetId,
    kind,
    executedAt,
    units: units as InvestmentOperation["units"],
    pricePerUnit: pricePerUnit as InvestmentOperation["pricePerUnit"],
    currency: "EUR",
    feesMinor,
  };
}
