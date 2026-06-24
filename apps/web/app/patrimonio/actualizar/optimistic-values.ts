import { parseMoneyMinor } from "@web/intake-primitives";

/**
 * Pure optimistic-merge for the "Puesta al día" batch value pass (#521, S5 of
 * #485, interaction-patterns §4/§7). The client form folds the just-submitted
 * edits over the rows' server values so each row's "Actual:" shows its new amount
 * BEFORE `batchValueUpdateAction` resolves; the redirect to /patrimonio settles
 * it (or, on the error redirect, the form re-renders with server values + the
 * error band). Pure (no React) so the behaviour unit-tests in the node env while
 * the form stays a thin `useOptimistic` shell.
 */

/** One row's optimistic value override, keyed by holding id. */
export interface ValueEdit {
  id: string;
  valueMinor: number;
}

/**
 * Read the puesta-al-día submission's `val_<id>` fields into edits, in `ids`
 * order. A blank or unparseable field is dropped, so that row simply keeps its
 * server value — the same rows the action itself parses (intake `parseMoneyMinor`).
 */
export function parseValueEdits(formData: FormData, ids: readonly string[]): ValueEdit[] {
  const edits: ValueEdit[] = [];
  for (const id of ids) {
    const raw = formData.get(`val_${id}`);
    const valueMinor = typeof raw === "string" ? parseMoneyMinor(raw) : null;
    if (valueMinor !== null) {
      edits.push({ id, valueMinor });
    }
  }
  return edits;
}

/**
 * The base id→value map with each edit applied over it, as a fresh map (the base
 * is never mutated). Drives the optimistic "Actual:" amounts; ids absent from the
 * edits keep their base value.
 */
export function applyValueEdits(
  base: ReadonlyMap<string, number>,
  edits: readonly ValueEdit[],
): Map<string, number> {
  const next = new Map(base);
  for (const edit of edits) {
    next.set(edit.id, edit.valueMinor);
  }
  return next;
}
