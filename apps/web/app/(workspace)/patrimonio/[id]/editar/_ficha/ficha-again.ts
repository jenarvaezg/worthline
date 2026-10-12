/**
 * «Añadir otra» (#1829): what a submit from the ficha's side panel leaves behind,
 * and how its success is told apart from every other one.
 *
 * The panel's forms keep the terminal they always had — success redirects, the
 * record form's refusal comes back as state (#1311, interaction-patterns §4.1) — so
 * nothing here touches the submit. The ficha only remembers, as the form leaves,
 * which action sent it, where its terminal returns, and the values worth keeping
 * for the next one: the DATE and the CURRENCY, never a figure. When the URL then
 * lands on exactly that return URL plus its `ok`, it was that submit's success,
 * and the notice can offer to open the same form again with those values.
 *
 * Read off the URL rather than the form's own state on purpose: a refusal comes
 * back in place (as state, or as `?error=`), and another form's success on the same
 * ficha (`«Lo básico»` → `?pestaña=datos&ok=saved`) lands somewhere else, so
 * neither can pass for it.
 *
 * Pure (interaction-patterns §7): the island owns the event and the `ref`; the
 * rules are tested here.
 */

import type { FormSeed } from "@web/_components/form-seed";

/**
 * The fields a re-opened form keeps: the operation's date and currency, the
 * one-off cobro's date. Amounts, units and notes are what changes from one to the
 * next, so they start blank.
 */
const SEEDED_FIELDS = ["executedAt", "currency", "dateISO"] as const;

/** The read side of `FormData`. */
export interface FormDataReader {
  get(name: string): FormDataEntryValue | null;
}

/** A submit that left the side panel: enough to recognise its terminal and refill the form. */
export interface PanelSubmission {
  /** The action whose panel sent it. */
  action: string;
  /** Where its terminal returns — the `currentUrl` the form posted. */
  returnUrl: string;
  seed: FormSeed;
}

/** Where the island is now. */
export interface Landing {
  pathname: string;
  /** The query string, with or without its leading `?`. */
  search: string;
}

/**
 * What a submit from `action`'s panel leaves behind, or null when the form posts
 * no return URL — a terminal that cannot be recognised offers nothing.
 */
export function panelSubmission(
  action: string,
  formData: FormDataReader,
  choice?: string | null,
): PanelSubmission | null {
  const returnUrl = formData.get("currentUrl");
  if (typeof returnUrl !== "string" || returnUrl === "") return null;

  const values: Record<string, string> = {};
  for (const field of SEEDED_FIELDS) {
    const value = formData.get(field);
    if (typeof value === "string" && value.trim() !== "") values[field] = value.trim();
  }
  return {
    action,
    returnUrl,
    seed: choice ? { choice, values } : { values },
  };
}

function entriesOf(search: string): string[] {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return [...params.entries()].map(([key, value]) => `${key}=${value}`).sort();
}

/**
 * The `ok` key when `landing` is the success terminal of `submission` — its return
 * URL with the `ok` the action appended (`successRedirectUrl`) and nothing else —
 * or null for anything else: a refusal, another form's success, the URL it left
 * from.
 */
export function landedOk(submission: PanelSubmission, landing: Landing): string | null {
  const [path = "", query = ""] = submission.returnUrl.split("?", 2);
  if (path !== landing.pathname) return null;

  const params = new URLSearchParams(
    landing.search.startsWith("?") ? landing.search.slice(1) : landing.search,
  );
  const ok = params.get("ok");
  if (!ok) return null;
  params.delete("ok");

  const landed = entriesOf(params.toString());
  const expected = entriesOf(query);
  return landed.length === expected.length &&
    landed.every((entry, index) => entry === expected[index])
    ? ok
    : null;
}
