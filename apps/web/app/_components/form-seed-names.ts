/**
 * The names «Añadir otra» works with (#1829), in one place (#1731 review): which
 * fields a re-opened form keeps, and the attribute that names a form's variant.
 *
 * A plain module, not the `"use client"` `form-seed.tsx`: a server component (the
 * Cobros entry) prints the attribute on its panes, and a value exported from a
 * client module reaches a server component as a reference, not as the string.
 */

/**
 * The fields a re-opened form keeps: the operation's date and currency, the one-off
 * cobro's date. Amounts, units and notes are what changes from one to the next, so
 * they start blank.
 */
export const SEEDED_FIELDS = ["executedAt", "currency", "dateISO"] as const;

export type SeededField = (typeof SEEDED_FIELDS)[number];

/**
 * The attribute that names which variant of a form a pane holds, so the ficha can
 * tell, as a form leaves, which of them was sent (`closest(...)` from the form).
 */
export const SEED_CHOICE_ATTRIBUTE = "data-seed-choice";

/** The pane of `choice`, as attributes to spread on it. */
export function seedChoicePane(choice: string): { [SEED_CHOICE_ATTRIBUTE]: string } {
  return { [SEED_CHOICE_ATTRIBUTE]: choice };
}
