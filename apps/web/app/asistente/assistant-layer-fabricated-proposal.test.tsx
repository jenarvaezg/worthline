import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1262: the faked ceremony reaches the panel and the panel
 * contradicts it. The detector itself is tested in `fabricated-proposal.test.ts`;
 * what this file proves is that the note is actually rendered next to the turn,
 * and NOT rendered next to a real proposal.
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
import { FABRICATED_PROPOSAL_NOTE } from "./fabricated-proposal";

const FAKE_CEREMONY =
  "He preparado la propuesta de corrección para actualizar el saldo a 5.511,96 €.\n\n" +
  "¿Deseas que proceda con la aplicación de este cambio?";

function assistantTurn(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", parts, role: "assistant" };
}

beforeEach(() => {
  chatMessages = [];
  chatStatus = "ready";
});

describe("AssistantLayer · faked proposal ceremony (#1262)", () => {
  test("prints the app's warning next to a turn that invented the proposal", () => {
    chatMessages = [assistantTurn([{ text: FAKE_CEREMONY, type: "text" }])];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain("assistantFakeProposal");
    expect(html).toContain("Aviso de worthline");
    // The sentence the user needs: their «confirmo» will not apply anything.
    expect(html).toContain("no aplica nada");
    expect(FABRICATED_PROPOSAL_NOTE).toContain("no aplica nada");
  });

  test("stays silent when the turn really prepared one", () => {
    chatMessages = [
      assistantTurn([
        { text: FAKE_CEREMONY, type: "text" },
        {
          input: { holdingId: "wl_hld_1" },
          output: { mode: "declare_balance", proposalId: "p1" },
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_correction",
        } as unknown as UIMessage["parts"][number],
      ]),
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).not.toContain("assistantFakeProposal");
  });

  test("says nothing while the turn is still streaming", () => {
    chatMessages = [assistantTurn([{ text: FAKE_CEREMONY, type: "text" }])];
    chatStatus = "streaming";

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).not.toContain("assistantFakeProposal");
  });
});
