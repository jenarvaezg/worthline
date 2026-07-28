import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The reported turn of #1317, rebuilt part by part: an alta from an attachment
 * whose summary the model wrote before `propose_holding` and wrote AGAIN in the step
 * the SDK opens after `suggest_actions`. The trim itself is tested in
 * `repeated-prose.test.ts`; what this file proves is that the panel prints the
 * summary — and the card's folio — once.
 *
 * Rendered through the onboarding variant because the floating panel ships closed
 * (only its launcher is in the markup until a click), and both surfaces share the
 * same `ConversationParts`.
 */

let chatMessages: UIMessage[] = [];

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bienvenida",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";
import { HOLDING_CREATION_FOLIO } from "./holding-creation-proposal-contract";

const FIRST_PARAGRAPH =
  "He preparado una propuesta para dar de alta el fondo Vanguard Global Stock con " +
  "su valor de hoy, 12.585 € a 28 de julio de 2026.";
const SECOND_PARAGRAPH =
  "Para que el valor de esta posición se actualice solo, he resuelto su símbolo de " +
  "mercado; si lo confirmas, worthline lo seguirá a diario.";
const SUMMARY = `${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}`;

const HOLDING_CREATION_OUTPUT = {
  proposalType: "holding_creation",
  draft: { proposalId: "p1" },
  folio: HOLDING_CREATION_FOLIO,
  family: "fund",
  holding: {
    name: "Vanguard Global Stock",
    instrumentLabel: "Fondo",
    detail: "12.585 €",
  },
  impact: { beforeMinor: 100_000, afterMinor: 1_358_500, deltaMinor: 1_258_500 },
  duplicate: null,
  priceTrackingWarning: null,
};

function toolPart(
  type: string,
  output: unknown,
  toolCallId: string,
): UIMessage["parts"][number] {
  return {
    input: {},
    output,
    state: "output-available",
    toolCallId,
    type,
  } as unknown as UIMessage["parts"][number];
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

beforeEach(() => {
  chatMessages = [];
});

describe("AssistantLayer · a proposal summary written twice (#1317)", () => {
  test("prints the recap once even though the turn carries it twice", () => {
    chatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { text: SUMMARY, type: "text" },
          toolPart("tool-propose_holding", HOLDING_CREATION_OUTPUT, "call-1"),
          toolPart("tool-suggest_actions", { actions: [] }, "call-2"),
          { text: SUMMARY, type: "text" },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    // The card is there — the trim never eats the proposal it accompanies.
    expect(html).toContain("assistantProposal");
    expect(occurrences(html, FIRST_PARAGRAPH)).toBe(1);
    expect(occurrences(html, SECOND_PARAGRAPH)).toBe(1);
  });

  test("the alta card states its folio once", () => {
    chatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [toolPart("tool-propose_holding", HOLDING_CREATION_OUTPUT, "call-1")],
      },
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(occurrences(html, HOLDING_CREATION_FOLIO)).toBe(1);
  });

  test("leaves a turn that says something new in its second part alone", () => {
    chatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { text: FIRST_PARAGRAPH, type: "text" },
          toolPart("tool-propose_holding", HOLDING_CREATION_OUTPUT, "call-1"),
          { text: SECOND_PARAGRAPH, type: "text" },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(occurrences(html, FIRST_PARAGRAPH)).toBe(1);
    expect(occurrences(html, SECOND_PARAGRAPH)).toBe(1);
  });
});
