"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  FEEDBACK_BUTTON_LABEL,
  FEEDBACK_IDLE,
  type FeedbackFormState,
  feedbackFormView,
} from "./feedback-message";
import { submitFeedbackAction } from "./submit-feedback-action";

/**
 * «Enviar feedback» (#1174): a button in the surface's top bar and a native modal
 * `<dialog>` with one textarea. A thin shell (interaction-patterns §7): what the
 * form shows — sendability, status line and its recipe — is `feedbackFormView`, a
 * pure function with its own tests.
 *
 * Why a `<dialog>` opened with `showModal()`: it lands in the top layer, so no top
 * bar can clip it, and the browser gives the rest of §8 for free — focus moves into
 * it on open, stays trapped while open, returns to the button on close, and Escape
 * closes it. It carries `.coverSheet` because some top bars are cover surfaces:
 * the dialog sits in their DOM, and without the restored paper tokens it would
 * inherit the cover's light ink on a light sheet.
 *
 * The draft and its id live HERE, above the form, so closing the dialog never
 * discards what the user wrote, and a retry of the same draft sends the same id
 * (one alert, one email key); only a delivered message clears both. The submit
 * goes through `onSubmit` + a manual dispatch rather than `<form action>`: React 19
 * resets a form after its action runs, and a reset that wiped the textarea on a
 * failed send would lose exactly the message the error asks them to retry. There
 * is no `maxLength` either: the browser would silently cut a long paste, and the
 * form says the limit in words instead.
 */
export default function FeedbackLauncher() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const draftIdRef = useRef<string | null>(null);
  // Remounting the form is how a delivered message's confirmation is cleared for
  // the next open: `useActionState` has no reset of its own.
  const [formKey, setFormKey] = useState(0);
  const deliveredRef = useRef(false);
  const titleId = useId();

  function handleClose() {
    if (!deliveredRef.current) return;
    deliveredRef.current = false;
    setFormKey((key) => key + 1);
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="btnSecondary feedbackLauncher"
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        {FEEDBACK_BUTTON_LABEL}
      </button>
      <dialog
        aria-labelledby={titleId}
        className="feedbackSheet coverSheet"
        onClose={handleClose}
        ref={dialogRef}
      >
        <FeedbackForm
          draft={draft}
          draftId={() => {
            draftIdRef.current ??= crypto.randomUUID();
            return draftIdRef.current;
          }}
          key={formKey}
          onClose={() => dialogRef.current?.close()}
          onDelivered={() => {
            deliveredRef.current = true;
            draftIdRef.current = null;
            setDraft("");
          }}
          onDraftChange={setDraft}
          titleId={titleId}
        />
      </dialog>
    </>
  );
}

function FeedbackForm({
  draft,
  draftId,
  onClose,
  onDelivered,
  onDraftChange,
  titleId,
}: {
  draft: string;
  draftId: () => string;
  onClose: () => void;
  onDelivered: () => void;
  onDraftChange: (draft: string) => void;
  titleId: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, dispatch, pending] = useActionState(
    async (previous: FeedbackFormState, formData: FormData) => {
      const next = await submitFeedbackAction(previous, formData);
      if (next.status === "sent") onDelivered();
      return next;
    },
    FEEDBACK_IDLE,
  );
  const view = feedbackFormView({ draft, pending, state });

  // The submit button goes disabled with the cleared draft, and a disabled
  // control drops focus to the page: hand it to «Cerrar», the next thing to do.
  useEffect(() => {
    if (state.status === "sent") closeRef.current?.focus();
  }, [state]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    // Which screen the message is about: the path only (see `parseFeedbackPage`).
    formData.set("page", window.location.pathname);
    formData.set("feedbackId", draftId());
    startTransition(() => dispatch(formData));
  }

  return (
    <form className="stackForm feedbackForm" onSubmit={handleSubmit}>
      <h2 id={titleId}>{FEEDBACK_BUTTON_LABEL}</h2>
      <p className="feedbackLede">
        Lo lee el desarrollador de worthline tal cual lo escribas: un fallo, algo que no
        se entiende o algo que echas en falta. Le llega con la pantalla en la que estás y
        con tu correo, por si necesita preguntarte algo.
      </p>
      <label>
        Tu mensaje
        <textarea
          name="message"
          onChange={(event) => onDraftChange(event.target.value)}
          required
          rows={6}
          value={draft}
        />
      </label>
      <p aria-live="polite" className={view.statusClassName} role="status">
        {view.status?.text ?? ""}
      </p>
      <div className="feedbackActions">
        <button aria-busy={pending || undefined} disabled={!view.canSubmit} type="submit">
          {view.submitLabel}
        </button>
        <button className="btnSecondary" onClick={onClose} ref={closeRef} type="button">
          Cerrar
        </button>
      </div>
    </form>
  );
}
