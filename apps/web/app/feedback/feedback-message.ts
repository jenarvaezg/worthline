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

/**
 * Where the button lives, in the words the assistant uses. Shared for the same
 * reason as the label: every surface that mounts the button puts it in its top
 * bar (the workspace topbar, the estreno and /empezar mastheads, the legal cover,
 * the error page), and `capability-destinations.test.ts` holds that list against
 * the code.
 */
export const FEEDBACK_BUTTON_PLACE = "en la barra superior";

/** Long enough for a real report with steps; short enough to stay a message. */
export const FEEDBACK_MAX_LENGTH = 4000;

const PAGE_MAX_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * The message as the user typed it, trimmed at the edges only. Line breaks are
 * normalized to LF BEFORE measuring: a form post turns each one into CRLF, and
 * counting those twice would refuse on the server a message the textarea
 * accepted. Over the cap is a refusal, never a silent truncation: cutting what
 * someone wrote and saying «recibido» would deliver a different message.
 */
export function parseFeedbackMessage(raw: unknown): ParsedFeedbackMessage {
  const message = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (message.length === 0) {
    return { error: "Escribe qué has visto o qué echas en falta.", ok: false };
  }
  if (message.length > FEEDBACK_MAX_LENGTH) {
    return {
      error: "El mensaje pasa de 4.000 caracteres: acórtalo o envíalo en dos.",
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

/**
 * The id the client minted for this draft, or null when it is not a uuid. Stable
 * across retries of the same draft, so a resend lands on the same alert and the
 * same email idempotency key instead of minting duplicates.
 */
export function parseFeedbackId(raw: unknown): string | null {
  return typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
}

type FeedbackStatus = { text: string; tone: "pending" | "sent" | "error" };

export interface FeedbackFormView {
  canSubmit: boolean;
  submitLabel: string;
  /** The line the form announces (`aria-live`), or null when it has nothing to say. */
  status: FeedbackStatus | null;
  /** The canon recipe for that line: a success or error band, or bare text. */
  statusClassName: string;
}

const STATUS_CLASS: Record<FeedbackStatus["tone"], string> = {
  error: "feedbackStatus formError",
  pending: "feedbackStatus",
  sent: "feedbackStatus successBand",
};

/**
 * What the form shows. The send is NOT optimistic (interaction-patterns §4): the
 * server decides whether the message reached anywhere, so the form shows an
 * honest pending and confirms only what came back. The confirmation stays until
 * the user starts a new message; an error stays while its draft is there to
 * retry. Sendability is `parseFeedbackMessage` itself — the server's own rule.
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
  const status = feedbackStatus({ draft, pending, state });
  return {
    canSubmit: !pending && parseFeedbackMessage(draft).ok,
    status,
    statusClassName: status ? STATUS_CLASS[status.tone] : "feedbackStatus",
    submitLabel: pending ? "Enviando…" : "Enviar",
  };
}

function feedbackStatus({
  draft,
  pending,
  state,
}: {
  draft: string;
  pending: boolean;
  state: FeedbackFormState;
}): FeedbackStatus | null {
  if (pending) return { text: "Enviando…", tone: "pending" };
  const hasDraft = draft.trim().length > 0;
  const parsed = parseFeedbackMessage(draft);
  // Only the length refusal speaks before a send: «escribe algo» over an empty
  // field the user has not touched would scold before they started.
  if (hasDraft && !parsed.ok) return { text: parsed.error, tone: "error" };
  if (state.status === "error") return { text: state.error, tone: "error" };
  if (state.status === "sent" && !hasDraft) {
    return {
      text: "Recibido, gracias. Ya le ha llegado al desarrollador.",
      tone: "sent",
    };
  }
  return null;
}
