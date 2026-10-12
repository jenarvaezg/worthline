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
 * The submit choreography itself — the in-flight guard, the optimistic dispatch,
 * collecting the refusal the action hands back — lives here too
 * ({@link submitIncomeMutation}), the shape of `submitOperationRecord`, so the two
 * islands that submit (the door and a row's correction) are thin shells over it.
 *
 * Pure (no React), so it unit-tests in node.
 */

import {
  type RecordActionResult,
  rejectionOf,
} from "@web/_components/optimistic-operations";
import type { Income } from "@worthline/domain";
import {
  buildIncomeResult,
  type IncomeCorrection,
  incomeCorrectionFieldsFromForm,
  incomeFieldsFromForm,
  parseIncomeCorrection,
} from "./income-form";

/** The mutations an income list can show before the server answers. */
export type IncomeMutation =
  | { kind: "add"; income: Income }
  | { kind: "update"; id: string; correction: IncomeCorrection }
  | { kind: "delete"; id: string };

function applyOne(list: readonly Income[], mutation: IncomeMutation): Income[] {
  switch (mutation.kind) {
    case "add":
      return [...list, mutation.income];
    case "update":
      return list.map((income) =>
        income.id === mutation.id ? { ...income, ...mutation.correction } : income,
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

/** What a submit does: show the mutation, or say why not without a round-trip. */
export type IncomeSubmitPlan =
  | { kind: "optimistic"; mutation: IncomeMutation }
  | { kind: "reject"; error: string };

/** Plan a submit of the declaration door: the new row, or the parser's refusal. */
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
    mutation: {
      kind: "add",
      income: {
        ...rest,
        id: newId(),
        holdingId,
        endISO: endISO ?? null,
        expensesMinor: expensesMinor ?? null,
        exclusions: [],
      },
    },
  };
}

/**
 * Plan a submit of a row's correction. Only the declaration fields the form carried
 * are part of it — an absent one is left as it is, never mistaken for a chosen «Sin
 * declarar» — and, on an income with no asset, its whole recurrence (#1813).
 */
export function planDeclarationUpdate({
  formData,
  today,
}: {
  formData: FormData;
  today: string;
}): IncomeSubmitPlan {
  const result = parseIncomeCorrection(incomeCorrectionFieldsFromForm(formData), today);
  if (!result.ok) return { kind: "reject", error: result.error };
  return {
    kind: "optimistic",
    mutation: {
      kind: "update",
      id: String(formData.get("incomeId") ?? ""),
      correction: result.correction,
    },
  };
}

/** What a declaration action resolves to: nothing on success (it redirects), a refusal otherwise. */
export type IncomeAction = (
  formData: FormData,
) => RecordActionResult | Promise<RecordActionResult>;

/** The mutable in-flight flag — a React ref in the island, a plain object in tests. */
export interface InFlightRef {
  current: boolean;
}

/**
 * Run one submit of an income form (#1673): skip it while another is in flight,
 * refuse it on the spot when the plan says so, otherwise show the mutation and call
 * the action inside the caller's transition, reporting whatever refusal it hands
 * back.
 *
 * The plan is a thunk so a click that arrives while a submit is in flight costs
 * nothing: two clicks inside one frame both reach the handler before `isPending`
 * flips, and only the ref sees the first. The flag is cleared in a `finally`, so a
 * failed action still lets the person retry. `inlineError` is stamped on the body
 * here, never in the HTML (#1311): a no-JS post keeps the redirect terminal.
 */
export function submitIncomeMutation({
  action,
  formData,
  inFlight,
  onRejection,
  plan,
  showOptimistic,
  startTransition,
}: {
  action: IncomeAction;
  formData: FormData;
  inFlight: InFlightRef;
  /** The refusal to show, or null to clear the previous one as the retry leaves. */
  onRejection: (message: string | null) => void;
  plan: () => IncomeSubmitPlan;
  showOptimistic: (mutation: IncomeMutation) => void;
  startTransition: (scope: () => Promise<void>) => void;
}): void {
  if (inFlight.current) return;
  const planned = plan();
  if (planned.kind === "reject") {
    onRejection(planned.error);
    return;
  }
  formData.set("inlineError", "1");
  onRejection(null);
  inFlight.current = true;
  startTransition(async () => {
    showOptimistic(planned.mutation);
    try {
      onRejection(rejectionOf(await action(formData))?.message ?? null);
    } finally {
      inFlight.current = false;
    }
  });
}
