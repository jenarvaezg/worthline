/**
 * The `formId`s the Cobros forms tag a refusal with, so it comes back to the exact
 * form that produced it (#1731 review).
 *
 * The entry forms and the record's controls used to share one id, `payout`, and so
 * one place to land: the tabbed ficha sent every Cobros refusal to its tab — and a
 * one-off cobro refused in the «Añadir cobro» panel came back to a closed panel,
 * its amount and note lost and the panel back on «Un cobro suelto» even when it
 * was the recurring one that failed. Each form now names itself: the actions write
 * the id, the ficha reads it to reopen that form with what was typed. They live in
 * a plain module, not in a `"use server"` file (which may only export functions),
 * so the two halves cannot drift apart.
 */

/** Which Cobros form produced a refusal. */
export const COBRO_FORM_ID = {
  /** A declared income's controls on the record — its costs, its lease terms. */
  record: "payout",
  /** The entry's one-off cobro. */
  oneOff: "payoutOneOff",
  /** The entry's recurring cobro (a no-JS post: with JS its refusal is state). */
  recurring: "payoutRecurring",
} as const;

export type CobroFormId = (typeof COBRO_FORM_ID)[keyof typeof COBRO_FORM_ID];

const COBRO_FORM_IDS: readonly string[] = Object.values(COBRO_FORM_ID);

/** Whether a refusal's `formId` is one of the Cobros forms'. */
export function isCobroFormId(formId: string | null | undefined): formId is CobroFormId {
  return formId != null && COBRO_FORM_IDS.includes(formId);
}
