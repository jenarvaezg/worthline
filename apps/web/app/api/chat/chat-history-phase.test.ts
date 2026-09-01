import { FABRICATED_ALERT_MODEL_NOTE } from "@web/asistente/fabricated-maintainer-alert";
import { FABRICATED_PROPOSAL_MODEL_NOTE } from "@web/asistente/fabricated-proposal";
import { TOOL_PROMPT_BUDGET } from "@web/asistente/turn-prompt-budget";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { repairHistoryForModel } from "./chat-history-phase";

/**
 * The ORDER between the four repairs, pinned (#1697).
 *
 * It used to live in a comment inside a 500-line handler, and it is not a stylistic
 * preference: both fabricated-ceremony corrections MUST run on the untouched history,
 * because the prune removes exactly the part that tells «worthline was asked and the
 * stream died» apart from «nobody ever asked». Invert the two and the app starts
 * telling the model it invented a ceremony it really did request.
 */

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, parts, role: "assistant" };
}

function textPart(text: string): UIMessage["parts"][number] {
  return { text, type: "text" };
}

function inFlightCall(type: string, toolCallId: string): UIMessage["parts"][number] {
  return {
    input: {},
    state: "input-available",
    toolCallId,
    type,
  } as unknown as UIMessage["parts"][number];
}

function prose(messages: UIMessage[]): string {
  return JSON.stringify(messages);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("repairHistoryForModel", () => {
  test("the proposal correction reads the history BEFORE the prune takes the call away", () => {
    // A turn that claimed a proposal AND really asked for one whose stream died. Read
    // first, it is `interrupted` — and an interrupted turn is deliberately left out of
    // the model note, because `propose_*` persists before returning and the prune's own
    // note is the truer one. Read after the prune, the call is gone and the turn would
    // be accused of inventing the ceremony outright.
    const repaired = repairHistoryForModel(
      [
        { id: "u1", parts: [textPart("Corrige el saldo")], role: "user" },
        assistantMessage("a1", [
          textPart("He preparado la propuesta de corrección."),
          inFlightCall("tool-propose_correction", "call-1"),
        ]),
      ],
      TOOL_PROMPT_BUDGET,
    );

    expect(prose(repaired)).not.toContain(FABRICATED_PROPOSAL_MODEL_NOTE);
    // And the orphan really was pruned, so the SDK can still convert the prompt.
    expect(prose(repaired)).not.toContain("call-1");
  });

  test("the alert correction reads it before the prune too", () => {
    // `raise_maintainer_alert` writes through the control plane BEFORE it returns, so a
    // call still in flight may have filed a real incident: the guard exempts the turn.
    // Prune first and the app would tell the model no alert exists — while one does.
    const repaired = repairHistoryForModel(
      [
        { id: "u1", parts: [textPart("Levanta una incidencia")], role: "user" },
        assistantMessage("a1", [
          textPart("He registrado la incidencia."),
          inFlightCall("tool-raise_maintainer_alert", "call-2"),
        ]),
      ],
      TOOL_PROMPT_BUDGET,
    );

    expect(prose(repaired)).not.toContain(FABRICATED_ALERT_MODEL_NOTE);
    expect(prose(repaired)).not.toContain("call-2");
  });

  test("still corrects the turn that asked for nothing at all", () => {
    // The control case: no lane, no excuse — the note the whole repair exists for.
    const repaired = repairHistoryForModel(
      [assistantMessage("a1", [textPart("He preparado la propuesta de corrección.")])],
      TOOL_PROMPT_BUDGET,
    );
    expect(prose(repaired)).toContain(FABRICATED_PROPOSAL_MODEL_NOTE);
  });

  test("leaves a healthy conversation untouched", () => {
    const healthy: UIMessage[] = [
      { id: "u1", parts: [textPart("¿Cuánto tengo?")], role: "user" },
      assistantMessage("a1", [textPart("Tienes 100 €.")]),
    ];
    expect(repairHistoryForModel(healthy, TOOL_PROMPT_BUDGET)).toEqual(healthy);
  });
});
