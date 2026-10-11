"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";

import {
  FEEDBACK_BUTTON_LABEL,
  FEEDBACK_IDLE,
  FEEDBACK_MAX_LENGTH,
  type FeedbackFormState,
  feedbackFormView,
} from "./feedback-message";
import { submitFeedbackAction } from "./submit-feedback-action";

/**
 * «Enviar feedback» (#1174): a button in the topbar and a native modal `<dialog>`
 * with one textarea. A thin shell (interaction-patterns §7): what the form shows
 * is `feedbackFormView`, a pure function with its own tests.
 *
 * Why a `<dialog>` opened with `showModal()`: it lands in the top layer, so the
 * topbar's horizontally scrolling strip cannot clip it, and the browser gives the
 * rest of §8 for free — focus moves into it on open, stays trapped while open,
 * returns to the button on close, and Escape closes it.
 *
 * The draft lives HERE, above the form, so closing the dialog never discards what
 * the user wrote; only a delivered message clears it. The submit goes through
 * `onSubmit` + a manual dispatch rather than `<form action>`: React 19 resets a
 * form after its action runs, and a reset that wiped the textarea on a failed send
 * would lose exactly the message the error asks them to retry.
 */
export default function FeedbackLauncher() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  // Remounting the form is how a delivered message's confirmation is cleared for
  // the next open: `useActionState` has no reset of its own.
  const [formKey, setFormKey] = useState(0);
  const deliveredRef = useRef(false);

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
        aria-labelledby="feedback-title"
        className="feedbackSheet"
        onClose={handleClose}
        ref={dialogRef}
      >
        <FeedbackForm
          draft={draft}
          key={formKey}
          onClose={() => dialogRef.current?.close()}
          onDelivered={() => {
            deliveredRef.current = true;
            setDraft("");
          }}
          onDraftChange={setDraft}
        />
      </dialog>
    </>
  );
}

function FeedbackForm({
  draft,
  onClose,
  onDelivered,
  onDraftChange,
}: {
  draft: string;
  onClose: () => void;
  onDelivered: () => void;
  onDraftChange: (draft: string) => void;
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
    startTransition(() => dispatch(formData));
  }

  const statusClass =
    view.status?.tone === "sent"
      ? "feedbackStatus successBand"
      : view.status?.tone === "error"
        ? "feedbackStatus formError"
        : "feedbackStatus";

  return (
    <form className="stackForm feedbackForm" onSubmit={handleSubmit}>
      <h2 id="feedback-title">{FEEDBACK_BUTTON_LABEL}</h2>
      <p className="feedbackLede">
        Lo lee el desarrollador de worthline tal cual lo escribas: un fallo, algo que no
        se entiende o algo que echas en falta. Le llega con la pantalla en la que estás y
        con tu correo, por si necesita preguntarte algo.
      </p>
      <label>
        Tu mensaje
        <textarea
          maxLength={FEEDBACK_MAX_LENGTH}
          name="message"
          onChange={(event) => onDraftChange(event.target.value)}
          required
          rows={6}
          value={draft}
        />
      </label>
      <p aria-live="polite" className={statusClass} role="status">
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
