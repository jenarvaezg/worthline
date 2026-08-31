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

/**
 * The five fields, in posting order. They keep the pane's `tr*` names so the two
 * doors read the same document — a section that renamed them would drift the moment
 * one door gained a field.
 */
export const EXTERNAL_ENTRY_FORM_FIELDS = [
  "trAmount",
  "trPrice",
  "trDate",
  "trCost",
  "trSeniority",
] as const;

/** The posted capture, minus `today` — the action owns the clock. */
export type ExternalEntryFormValues = Omit<ExternalTransferCaptureInput, "today">;

export function readExternalEntryFormValues(formData: FormData): ExternalEntryFormValues {
  return {
    amountRaw: String(formData.get("trAmount") ?? ""),
    costRaw: String(formData.get("trCost") ?? ""),
    dateRaw: String(formData.get("trDate") ?? ""),
    priceRaw: String(formData.get("trPrice") ?? ""),
    seniorityRaw: String(formData.get("trSeniority") ?? ""),
  };
}
