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
import { proposalCardPart, rejectedProposalPart } from "./proposal-part-fixtures";

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

describe("AssistantLayer · faked proposal ceremony (#1262, #1468, #1515)", () => {
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
      assistantTurn([{ text: FAKE_CEREMONY, type: "text" }, proposalCardPart()]),
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).not.toContain("assistantFakeProposal");
    // The card really is on screen — the reason the note stays away.
    expect(html).toContain("assistantProposal");
  });

  test("warns when worthline REJECTED the proposal the turn narrated (#1468)", () => {
    // The hole this closed: a `propose_*` part was there by name, so the guard used
    // to switch off — precisely in the turn where the user needed it most.
    chatMessages = [
      assistantTurn([{ text: FAKE_CEREMONY, type: "text" }, rejectedProposalPart()]),
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain("assistantFakeProposal");
    // And it says which of the two things happened, without quoting the refusal.
    expect(html).toContain("no recibi");
    expect(html).not.toContain("operation_document_required");
  });

  test("drops the Confirmar chip on the turn that invented the ceremony (#1515)", () => {
    // Jorge's DEGIRO turn: worthline refused the proposal, the note of #1468
    // told him «confirmo» in the chat applies nothing — and under it sat a
    // primary chip labelled «Confirmar Reconciliación». That chip is a
    // navigation (`openInternalSource`), not a proposal confirm; clicking it
    // spun the `.navPending` ring and applied nothing. The chip itself is the
    // ceremony, so it must not render.
    chatMessages = [
      assistantTurn([
        { text: FAKE_CEREMONY, type: "text" },
        rejectedProposalPart(),
        {
          type: "tool-suggest_actions",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: {
            actions: [
              {
                type: "openInternalSource",
                label: "Confirmar Reconciliación",
                href: "/patrimonio",
              },
              {
                type: "openInternalSource",
                label: "Ver impacto en patrimonio",
                href: "/historico",
              },
            ],
          },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain("assistantFakeProposal");
    expect(html).not.toContain("Confirmar Reconciliación");
    expect(html).toContain("Ver impacto en patrimonio");
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
