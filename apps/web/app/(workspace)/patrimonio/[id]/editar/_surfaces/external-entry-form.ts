/**
 * The «Traer de otra entidad» form seam (#1518): what the ficha's section posts, and
 * how the action reads it back.
 *
 * It is a reader and a field list, and deliberately nothing else. The arithmetic,
 * the refusals and the copy all belong to `external-transfer-in.ts` — the pure module
 * the add wizard's pane already runs — so the two doors that write an external entry
 * cannot disagree about what a figure means or how a refusal is worded. A second
 * lookalike is what #1438 measured in wrong snapshots.
 */

import type { ExternalTransferCaptureInput } from "@web/patrimonio/anadir/external-transfer-in";

/** The posted capture, minus `today` — the action owns the clock. */
export type ExternalEntryFormValues = Omit<ExternalTransferCaptureInput, "today">;

/**
 * Posted field → the capture key it fills, in posting order. ONE table rather than a
 * name list beside a reader that spells the same five names again: the two would
 * drift the moment a sixth field appears, and the list is what a refusal round-trips
 * with (`preserveFields`), so a name missing from it silently loses what the user
 * typed.
 *
 * The names stay the pane's `tr*` so both doors post the same document.
 */
const FIELD_KEYS = {
  trAmount: "amountRaw",
  trPrice: "priceRaw",
  trDate: "dateRaw",
  trCost: "costRaw",
  trSeniority: "seniorityRaw",
} as const satisfies Record<string, keyof ExternalEntryFormValues>;

export const EXTERNAL_ENTRY_FORM_FIELDS = Object.keys(FIELD_KEYS) as ReadonlyArray<
  keyof typeof FIELD_KEYS
>;

export function readExternalEntryFormValues(formData: FormData): ExternalEntryFormValues {
  const values = {} as ExternalEntryFormValues;
  for (const [field, key] of Object.entries(FIELD_KEYS)) {
    values[key as keyof ExternalEntryFormValues] = String(formData.get(field) ?? "");
  }
  return values;
}
