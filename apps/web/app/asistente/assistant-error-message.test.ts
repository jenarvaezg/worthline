import { describe, expect, it } from "vitest";

import {
  ASSISTANT_GENERIC_ERROR,
  assistantErrorMessage,
} from "./assistant-error-message";

describe("assistantErrorMessage", () => {
  it("points at the only exit that exists when the body is refused", () => {
    // The whole point of #1260: this is the one case where «vuelve a intentarlo»
    // was the wrong advice, because the same history is refused every time. And
    // the advice has to be something the user can DO: no control clears the
    // conversation, so reloading is the exit.
    const message = assistantErrorMessage(new Error('{"error":"invalid_body"}'));

    expect(message).toContain("Recarga la página");
    expect(message).not.toContain("Vuelve a intentarlo");
  });

  it("distinguishes the codes the route can answer with", () => {
    expect(assistantErrorMessage(new Error('{"error":"rate_limited"}'))).toContain(
      "muchos mensajes seguidos",
    );
    expect(assistantErrorMessage(new Error('{"error":"unauthenticated"}'))).toContain(
      "sesión ha caducado",
    );
    expect(
      assistantErrorMessage(new Error('{"error":"attachment_too_large"}')),
    ).toContain("La petición es demasiado grande");
    expect(
      assistantErrorMessage(new Error('{"error":"assistant_unavailable"}')),
    ).toContain("no está disponible ahora mismo");
  });

  it("falls back to the generic sentence for anything unreadable", () => {
    expect(assistantErrorMessage(new Error("Failed to fetch"))).toBe(
      ASSISTANT_GENERIC_ERROR,
    );
    expect(assistantErrorMessage(new Error(""))).toBe(ASSISTANT_GENERIC_ERROR);
    expect(assistantErrorMessage(undefined)).toBe(ASSISTANT_GENERIC_ERROR);
    expect(assistantErrorMessage(new Error('{"error":"algo_nuevo"}'))).toBe(
      ASSISTANT_GENERIC_ERROR,
    );
  });

  it("never shows the raw body to the user", () => {
    // A proxy can answer with HTML or a stack trace; none of it belongs on screen.
    const message = assistantErrorMessage(
      new Error("<html><body>504 Gateway Time-out</body></html>"),
    );

    expect(message).toBe(ASSISTANT_GENERIC_ERROR);
  });
});
