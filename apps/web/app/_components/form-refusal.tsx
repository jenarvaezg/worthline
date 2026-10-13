/**
 * A form's own refusal, printed once inside the form that produced it (#1824 review).
 *
 * A server action that refuses a submission comes back on the URL with a `formId`
 * and what was typed (`FormErrorContext`). A form that prints its own refusal —
 * inside the ficha's side panel, which on a phone covers the page band — does three
 * things, always the same way:
 *  - it picks the refusal that is ITS own (`refusalFor`);
 *  - it prints it in the error band, with an `id` (`FormRefusal`);
 *  - its fields point at that band and read as invalid while it shows
 *    (`refusalAria`), so a screen reader says why the field was refused.
 */

import type { FormErrorContext } from "@web/intake";

/** The refusal that came back for `formId`, or null when it is another form's. */
export function refusalFor(
  formError: FormErrorContext | null,
  formId: string,
): FormErrorContext | null {
  return formError?.formId === formId ? formError : null;
}

/** What a refused form's field carries: the band that says why, and that it is invalid. */
export interface RefusalAria {
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

/**
 * The ARIA of a field whose form may be refused: `errorId` is the band's `id` while
 * the band shows, undefined otherwise — then the field carries nothing.
 */
export function refusalAria(errorId: string | undefined): RefusalAria {
  return {
    "aria-describedby": errorId,
    "aria-invalid": errorId ? true : undefined,
  };
}

/** The error band, with the `id` its fields point at; nothing when there is no refusal. */
export function FormRefusal({
  id,
  refusal,
}: {
  id: string;
  refusal: FormErrorContext | null;
}) {
  return refusal ? (
    <p className="errorBand" id={id} role="alert">
      {refusal.message}
    </p>
  ) : null;
}
