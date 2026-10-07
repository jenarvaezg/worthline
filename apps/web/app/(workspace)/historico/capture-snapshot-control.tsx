"use client";

import type { FormActionState } from "@web/form-action";
import { type FormEvent, useState, useTransition } from "react";

/**
 * The local-mode capture trigger — ADR 0037's missing writer, ADR 0030's
 * un-enumerable store.
 *
 * The rejection renders HERE, next to the button that earned it, because a
 * rejection must not travel in a navigation (ADR 0036's #1311 amendment,
 * interaction-patterns §4.1): the redirect terminal for a refusal is losable and
 * carries no recovery net, so the reason can simply never arrive. Hence the
 * submit leaves from this handler — React does not post the document when JS is
 * on, it sends the same action, so delegating to it would hand the refusal back
 * to exactly the terminal that loses it. With JS off the browser really does
 * post, `inlineError` is absent, and the server keeps its redirect terminal,
 * which is the only one such a form can render.
 *
 * The pending label is honest rather than optimistic (interaction-patterns §4):
 * a capture re-reads the whole workspace once per scope and the server decides
 * the figures, so there is nothing to predict. `PendingSubmit` is not reused here
 * because it reads `useFormStatus`, which tracks React's OWN form submission —
 * this form submits by hand, so that would report "idle" through the whole
 * capture and the button would read as frozen. Same contract, local button.
 *
 * `.btnSmall` goes on the BUTTON, not the form: it carries a border, padding and
 * background, which would otherwise draw a second box around the panel. It puts
 * the button in the same register as the `.rangeTabs a` segmented control it sits
 * beside, and `.historyControls` is already a flex row, so the form needs no class.
 * The hidden `currentUrl` is what carries the selected range back on the no-JS
 * terminal; it has no class because it never renders.
 *
 * Rendered only when the request is the local no-auth store (the page asks
 * `localCaptureAllowed`); the action re-checks regardless.
 */
export function CaptureSnapshotControl({
  action,
  currentUrl,
}: {
  action: (formData: FormData) => Promise<FormActionState>;
  currentUrl: string;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [isCapturing, startCapturing] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Serialized from the form itself, so this path and the no-JS post below it
    // send the same body — `currentUrl` is what carries the selected range back,
    // and rebuilding the FormData by hand here would silently drop it from the
    // terminal a no-JS browser reaches instead.
    const formData = new FormData(event.currentTarget);
    // Stamped here and never in the rendered HTML (ADR 0036's #1311 amendment): a
    // hidden input would put it in the no-JS post too, and that form can only
    // render the redirect terminal this opt-out exists to keep.
    formData.set("inlineError", "1");
    // Clear the previous reason as the retry leaves: keeping it up while a new
    // capture is in flight shows a stale refusal next to a form that has moved on.
    setRefusal(null);
    startCapturing(async () => {
      const result = await action(formData);
      // `ok: true` never arrives: the action redirects on success, so the state
      // that comes back is always a refusal worth showing.
      if (!result.ok) setRefusal(result.error);
    });
  }

  return (
    <form
      // The SAME server action reference, not a wrapper: `action=` is the no-JS
      // path, and React only renders the progressively-enhanceable form when it
      // can see the server action itself. React discards whatever the action
      // resolves to on that path — correct here, since without `inlineError` in
      // the body it redirects and never returns a rejection — but `action=`'s type
      // cannot say "returns something I will ignore".
      action={action as unknown as (formData: FormData) => void | Promise<void>}
      onSubmit={submit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <button
        aria-busy={isCapturing}
        className="btnSmall"
        disabled={isCapturing}
        type="submit"
      >
        {isCapturing ? "Capturando…" : "Capturar hoy"}
      </button>
      {refusal ? (
        <p className="errorBand" role="alert">
          {refusal}
        </p>
      ) : null}
    </form>
  );
}
