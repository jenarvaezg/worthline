import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_PENDING_READING,
  ASSISTANT_PENDING_THINKING,
  assistantPendingLabel,
} from "./assistant-pending";
import { userTurnText } from "./attachment-notice";

function userTurn(text: string): UIMessage {
  return { id: "u1", parts: [{ text, type: "text" }], role: "user" };
}

function assistantTurn(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", parts, role: "assistant" };
}

const EXTRACTION_CARD = {
  data: { fileName: "captura.jpg", result: { status: "unrecognized" } },
  type: "data-attachment-extraction",
} as unknown as UIMessage["parts"][number];

/**
 * #1286: the wait stops being silent, and the long wait says what it is waiting for.
 */
describe("visible pending signal (#1286)", () => {
  test("says nothing when no turn is in flight", () => {
    expect(
      assistantPendingLabel({ messages: [userTurn("hola")], status: "ready" }),
    ).toBeNull();
  });

  test("says nothing on an idle empty conversation", () => {
    expect(assistantPendingLabel({ messages: [], status: "ready" })).toBeNull();
  });

  test("thinks while the request is out and nothing has come back", () => {
    expect(
      assistantPendingLabel({ messages: [userTurn("hola")], status: "submitted" }),
    ).toBe(ASSISTANT_PENDING_THINKING);
  });

  test("names the long wait when the turn carried a file", () => {
    expect(
      assistantPendingLabel({
        messages: [userTurn(userTurnText("mira esto", "captura.jpg"))],
        status: "submitted",
      }),
    ).toBe(ASSISTANT_PENDING_READING);
  });

  test("stops naming the file once its reading card lands", () => {
    expect(
      assistantPendingLabel({
        messages: [
          userTurn(userTurnText("mira esto", "captura.jpg")),
          assistantTurn([EXTRACTION_CARD]),
        ],
        status: "streaming",
      }),
    ).toBe(ASSISTANT_PENDING_THINKING);
  });

  test("steps aside once the model's own words arrive", () => {
    expect(
      assistantPendingLabel({
        messages: [
          userTurn("hola"),
          assistantTurn([{ text: "Tu patrimonio es…", type: "text" }]),
        ],
        status: "streaming",
      }),
    ).toBeNull();
  });

  test("stays while the assistant turn exists but is still empty", () => {
    expect(
      assistantPendingLabel({
        messages: [userTurn("hola"), assistantTurn([{ text: "", type: "text" }])],
        status: "streaming",
      }),
    ).toBe(ASSISTANT_PENDING_THINKING);
  });

  test("an earlier turn's attachment does not name the current wait", () => {
    expect(
      assistantPendingLabel({
        messages: [
          userTurn(userTurnText("mira esto", "captura.jpg")),
          assistantTurn([EXTRACTION_CARD, { text: "Veo un pago.", type: "text" }]),
          userTurn("¿y mi liquidez?"),
        ],
        status: "submitted",
      }),
    ).toBe(ASSISTANT_PENDING_THINKING);
  });
});
