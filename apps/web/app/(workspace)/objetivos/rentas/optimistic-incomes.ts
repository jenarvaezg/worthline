/**
 * The optimistic half of the income declaration (#1673; interaction-patterns §4/§7).
 *
 * Declaring, correcting or deleting an income shows its result before the action
 * resolves: the row IS what the person typed, parsed by the same function the
 * server runs (`buildIncomeResult`), so the optimistic row is the stored row and
 * not a guess. Its counting status is derived from it by the same pure view, so
 * it is predictable too — nothing here is a server-computed figure waiting to
 * jump. A refusal is decided here as well, before any round-trip, by the very
 * parser the server would refuse with; the server stays the authority and runs it
 * again.
 *
 * Pure (no React), so it unit-tests in node while the islands stay thin
 * `useOptimistic` shells.
 */

import type { Income } from "@worthline/domain";
import {
  buildIncomeResult,
  incomeFieldsFromForm,
  type ParsedIncomeDeclaration,
  parseIncomeDeclaration,
} from "./income-form";

/** The mutations an income list can show before the server answers. */
export type IncomeMutation =
  | { kind: "add"; income: Income }
  | { kind: "update"; id: string; declaration: ParsedIncomeDeclaration }
  | { kind: "delete"; id: string };

function applyOne(list: readonly Income[], mutation: IncomeMutation): Income[] {
  switch (mutation.kind) {
    case "add":
      return [...list, mutation.income];
    case "update":
      return list.map((income) =>
        income.id === mutation.id ? { ...income, ...mutation.declaration } : income,
      );
    case "delete":
      return list.filter((income) => income.id !== mutation.id);
    default:
      return [...list];
  }
}

/** The base list with every pending mutation folded over it, as a fresh array. */
export function applyIncomeMutations(
  base: readonly Income[],
  pending: readonly IncomeMutation[],
): Income[] {
  return pending.reduce(applyOne, [...base]);
}

/** What a submit of the declaration form does: show the row, or say why not. */
export type IncomeSubmitPlan =
  | { kind: "optimistic"; draft: Income }
  | { kind: "reject"; error: string };

export function planIncomeSubmit({
  formData,
  holdingId,
  newId,
  today,
}: {
  formData: FormData;
  /** The holding the ficha links it to, or null on the Rentas surface. */
  holdingId: string | null;
  /** A fresh temporary key for the optimistic row. */
  newId: () => string;
  today: string;
}): IncomeSubmitPlan {
  const result = buildIncomeResult(incomeFieldsFromForm(formData), today);
  if (!result.ok) return { kind: "reject", error: result.error };
  const { endISO, expensesMinor, ...rest } = result.income;
  return {
    kind: "optimistic",
    draft: {
      ...rest,
      id: newId(),
      holdingId,
      endISO: endISO ?? null,
      expensesMinor: expensesMinor ?? null,
      exclusions: [],
    },
  };
}

/** What a submit of a row's «corregir la declaración» form does. */
export type DeclarationUpdatePlan =
  | { kind: "optimistic"; id: string; declaration: ParsedIncomeDeclaration }
  | { kind: "reject"; error: string };

export function planDeclarationUpdate({
  formData,
  today,
}: {
  formData: FormData;
  today: string;
}): DeclarationUpdatePlan {
  const fields = incomeFieldsFromForm(formData);
  const result = parseIncomeDeclaration(fields, today);
  if (!result.ok) return { kind: "reject", error: result.error };
  return {
    kind: "optimistic",
    id: String(formData.get("incomeId") ?? ""),
    declaration: result.declaration,
  };
}

/** What a declaration action resolves to: nothing on success (it redirects), a refusal otherwise. */
export type IncomeActionResult = void | { ok: true } | { ok: false; error: string };

/** The refusal in an action result, or null when it did not refuse. */
export function rejectionOf(result: IncomeActionResult): string | null {
  if (!result || result.ok) return null;
  return result.error;
}
