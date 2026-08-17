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

/**
 * What a submit of the record form should do (#1394). Two clicks four seconds
 * apart once left the father with two identical sells and ~1.000 € of evaporated
 * net worth, so the submit decision lives here — pure and testable — instead of
 * inline in the island:
 *
 * - `native`: the draft is unbuildable (blank units/price) — let the browser post
 *   so the server's validation surfaces the error.
 * - `optimistic`: add the row and run the action, carrying `submissionId` — the
 *   idempotency key the action seeds the operation id with.
 *
 * `inFlightSubmissionId` is the key of the submit currently in flight, or null
 * when there is none. A submit that arrives while one is in flight REUSES it, so
 * both POSTs resolve to the same operation id and the second writes nothing. That
 * is the half of the guard the disabled button cannot cover: `isPending` only
 * flips on the next render, so two clicks inside one frame both get through.
 * Rotating the key back to null once the action settles is what keeps two
 * legitimately identical operations (a split periodic buy) registrable.
 */
export type OperationSubmitPlan =
  | { kind: "native" }
  | { kind: "optimistic"; draft: InvestmentOperation; submissionId: string };

export function planOperationSubmit({
  assetId,
  formData,
  inFlightSubmissionId,
  newId,
  today,
}: {
  assetId: string;
  formData: FormData;
  inFlightSubmissionId: string | null;
  /** Fresh unique id per call (the island passes `crypto.randomUUID`). */
  newId: () => string;
  today: string;
}): OperationSubmitPlan {
  // The optimistic row's key is always fresh: a racing second click must not
  // collide with the row the first one already added.
  const draft = parseOperationDraft(formData, assetId, today, newId());
  if (!draft) return { kind: "native" };

  return { draft, kind: "optimistic", submissionId: inFlightSubmissionId ?? newId() };
}

/** The mutable holder of the in-flight key — a React ref in the island, a plain object in tests. */
export interface SubmissionKeyRef {
  current: string | null;
}

/**
 * Run a planned record submit (#1394): stamp the key onto the body, publish it as
 * the in-flight one, then add the optimistic row and call the action inside the
 * caller's transition.
 *
 * The two writes to `keyRef` are the whole guard, so they live here where a test
 * can fail if either goes missing. Publishing happens SYNCHRONOUSLY, before the
 * transition: a second click in the same frame has to see the key, which is
 * exactly the window `isPending` cannot cover. Clearing happens in a `finally`,
 * so even a rejected action rotates the key — otherwise the retry would be read
 * as a replay of a submission that never wrote anything.
 */
export function submitOperationRecord({
  addPending,
  formData,
  keyRef,
  plan,
  recordAction,
  startTransition,
}: {
  addPending: (mutation: OperationMutation) => void;
  formData: FormData;
  keyRef: SubmissionKeyRef;
  plan: Extract<OperationSubmitPlan, { kind: "optimistic" }>;
  recordAction: (formData: FormData) => void | Promise<void>;
  startTransition: (scope: () => Promise<void>) => void;
}): void {
  formData.set("submissionId", plan.submissionId);
  keyRef.current = plan.submissionId;
  startTransition(async () => {
    addPending({ kind: "add", operation: plan.draft });
    try {
      await recordAction(formData);
    } finally {
      // Settled: the next submit is a NEW operation, not a replay of this one —
      // a split periodic buy must stay registrable.
      keyRef.current = null;
    }
  });
}
