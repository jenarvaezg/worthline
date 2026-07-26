/**
 * What the panel says when a turn fails (#1260).
 *
 * The chat route answers a refusal with `{ "error": "<code>" }`, and the AI SDK
 * hands that body to the client as the thrown error's message. Rendering one
 * fixed sentence for all of them told the user to «vuelve a intentarlo» even when
 * retrying was the one thing that could not work: a conversation the route will
 * not accept is refused identically forever.
 */

/** Used when there is no code to read — a network drop, an aborted stream. */
export const ASSISTANT_GENERIC_ERROR =
  "El asistente no ha podido responder. Vuelve a intentarlo.";

const BY_CODE: Readonly<Record<string, string>> = {
  assistant_unavailable:
    "El asistente no está disponible ahora mismo. Vuelve a intentarlo en unos minutos.",
  // The byte ceiling this code comes from guards the whole request, and a turn
  // with no file at all can reach it (a very long conversation), so it must not
  // blame a file it may not carry.
  attachment_too_large:
    "La petición es demasiado grande. Si has adjuntado un archivo, prueba con uno más pequeño; si no, recarga la página para empezar de nuevo.",
  // Reachable in practice only when the conversation itself no longer fits, and
  // the same history travels in every later turn: retrying cannot help. It says
  // «recarga» and not «empieza una conversación nueva» because there is no control
  // that starts one — the panel keeps its messages for as long as the page lives.
  invalid_body:
    "Esta conversación es demasiado larga para seguir. Recarga la página para empezar de nuevo.",
  invalid_surface: "El asistente no está disponible en esta pantalla.",
  rate_limited:
    "Has enviado muchos mensajes seguidos. Espera un momento y vuelve a intentarlo.",
  unauthenticated:
    "Tu sesión ha caducado. Vuelve a entrar para seguir hablando con el asistente.",
};

/**
 * Reads the route's code out of the thrown error. The body is JSON, but a proxy
 * or a network failure can put anything there, so an unreadable message falls
 * back to the generic sentence instead of showing the raw text.
 */
export function assistantErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw) return ASSISTANT_GENERIC_ERROR;
  try {
    const parsed: unknown = JSON.parse(raw);
    const code =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { error?: unknown }).error
        : undefined;
    if (typeof code === "string" && code in BY_CODE) return BY_CODE[code]!;
  } catch {
    // Not JSON: nothing to read, and the raw text is not for the user's eyes.
  }
  return ASSISTANT_GENERIC_ERROR;
}
