import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1525: the incident the assistant said it filed and did not reaches the
 * panel, and the panel denies it. The detector itself is tested in
 * `fabricated-maintainer-alert.test.ts`; what this file proves is that the note is
 * rendered next to the turn — the half of the repair the history note cannot do, since
 * an alert paints no card whose absence the user could notice.
 *
 * Rendered through the onboarding variant because the floating panel ships closed
 * (only its launcher is in the markup until a click), and both surfaces share the
 * same `ConversationParts`.
 */

let chatMessages: UIMessage[] = [];
let chatStatus = "ready";

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    status: chatStatus,
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bienvenida",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";
import { FABRICATED_ALERT_NOTE } from "./fabricated-maintainer-alert";
import { raisedAlertPart, refusedAlertPart } from "./proposal-part-fixtures";

/** The prose the model actually emitted (#1525), trimmed. */
const FAKE_ALERT =
  "Te confirmo que he registrado la incidencia técnicamente como una limitación " +
  "del sistema.";

function assistantTurn(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", parts, role: "assistant" };
}

beforeEach(() => {
  chatMessages = [];
  chatStatus = "ready";
});

describe("AssistantLayer · fabricated maintainer alert (#1525)", () => {
  test("denies the incident next to the turn that was refused and claimed it anyway", () => {
    chatMessages = [
      assistantTurn([refusedAlertPart(), { text: FAKE_ALERT, type: "text" }]),
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain("assistantFakeAlert");
    expect(html).toContain("Aviso de worthline");
    // The sentence Jorge had to ask twice for: there is no ticket number.
    expect(html).toContain("no hay ticket");
    expect(FABRICATED_ALERT_NOTE).toContain("no hay ticket");
  });

  test("stays silent when the alert really was raised", () => {
    chatMessages = [
      assistantTurn([raisedAlertPart(), { text: FAKE_ALERT, type: "text" }]),
    ];

    expect(
      renderToStaticMarkup(
        <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
      ),
    ).not.toContain("assistantFakeAlert");
  });

  test("stays silent on an ordinary turn", () => {
    chatMessages = [
      assistantTurn([{ text: "Tu patrimonio neto es de 412.300,00 €.", type: "text" }]),
    ];

    expect(
      renderToStaticMarkup(
        <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
      ),
    ).not.toContain("assistantFakeAlert");
  });
});
