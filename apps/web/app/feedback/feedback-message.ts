/**
 * The pure half of the feedback channel (#1174): what a message may be, which
 * screen it came from, and what the form says at each moment. Shared by the
 * server action (validation) and the client island (view state), so the two can
 * never disagree about what is sendable — and testable without a browser
 * (interaction-patterns §7).
 */

/**
 * The button's words. Exported because two other surfaces name it: the
 * assistant's map of destinations and its note on a faked incident both send the
 * user here, and a rename that reached only the button would leave the assistant
 * pointing at a control that no longer exists.
 */
export const FEEDBACK_BUTTON_LABEL = "Enviar feedback";

/** Long enough for a real report with steps; short enough to stay a message. */
export const FEEDBACK_MAX_LENGTH = 4000;

const PAGE_MAX_LENGTH = 200;

/** The `useActionState` state of the feedback form. */
export type FeedbackFormState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string };

export const FEEDBACK_IDLE: FeedbackFormState = { status: "idle" };

export type ParsedFeedbackMessage =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * The message as the user typed it, trimmed at the edges only. Over the cap is a
 * refusal, never a silent truncation: cutting what someone wrote and saying
 * «recibido» would deliver a different message than the one they sent.
 */
export function parseFeedbackMessage(raw: unknown): ParsedFeedbackMessage {
  const message = typeof raw === "string" ? raw.trim() : "";
  if (message.length === 0) {
    return { error: "Escribe qué has visto o qué echas en falta.", ok: false };
  }
  if (message.length > FEEDBACK_MAX_LENGTH) {
    return {
      // Grouped by hand: es-ES ICU data leaves four-digit numbers ungrouped.
      error: `El mensaje pasa de ${String(FEEDBACK_MAX_LENGTH).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} caracteres: acórtalo o envíalo en dos.`,
      ok: false,
    };
  }
  return { message, ok: true };
}

/**
 * The in-app pathname the message was sent from, or null. Only the path: a query
 * string can carry typed amounts (#1311), and which screen is all the maintainer
 * needs. Anything that is not a same-origin path is dropped rather than stored.
 */
export function parseFeedbackPage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.length > PAGE_MAX_LENGTH) return null;
  if (!/^[\x21-\x7e]+$/.test(path)) return null;
  return path;
}

export interface FeedbackFormView {
  canSubmit: boolean;
  submitLabel: string;
  /** The line the form announces (`aria-live`), or null when it has nothing to say. */
  status: { text: string; tone: "pending" | "sent" | "error" } | null;
}

/**
 * What the form shows. The send is NOT optimistic (interaction-patterns §4): the
 * server decides whether the message reached anywhere, so the form shows an
 * honest pending and confirms only what came back. The confirmation stays until
 * the user starts a new message; an error stays while its draft is there to retry.
 */
export function feedbackFormView({
  draft,
  pending,
  state,
}: {
  draft: string;
  pending: boolean;
  state: FeedbackFormState;
}): FeedbackFormView {
  if (pending) {
    return {
      canSubmit: false,
      status: { text: "Enviando…", tone: "pending" },
      submitLabel: "Enviando…",
    };
  }
  const hasDraft = draft.trim().length > 0;
  const status: FeedbackFormView["status"] =
    state.status === "error"
      ? { text: state.error, tone: "error" }
      : state.status === "sent" && !hasDraft
        ? { text: "Recibido, gracias. Ya le ha llegado al desarrollador.", tone: "sent" }
        : null;
  return { canSubmit: hasDraft, status, submitLabel: "Enviar" };
}
