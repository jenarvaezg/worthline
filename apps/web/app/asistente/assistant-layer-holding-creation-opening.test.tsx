import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The alta card states the apertura it will persist (#1315): títulos, precio and
 * comisión, plus the coherence warning when the declared terms do not add up. The
 * payload is proven in `holding-creation-proposals.test.ts`; what this file proves
 * is that it REACHES the markup — the whole point of #1315 is that a user can see
 * «3 uds. × 54,545 €» before confirming instead of discovering 3,01814849 later.
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
import type { HoldingCreationProposal } from "./holding-creation-proposal-contract";
import { HOLDING_CREATION_FOLIO } from "./holding-creation-proposal-contract";

function altaProposal(
  overrides: Partial<HoldingCreationProposal> = {},
): HoldingCreationProposal {
  return {
    draft: { proposalId: "wl_prp_1315" },
    family: "investment",
    folio: HOLDING_CREATION_FOLIO,
    holding: {
      detail: "163,64 €",
      instrumentLabel: "Acción",
      name: "Acciones ACS",
      opening: { fees: "1,00 €", pricePerUnit: "54,545 €", units: "3" },
    },
    impact: { afterMinor: 163_64, beforeMinor: 0, deltaMinor: 163_64 },
    proposalType: "holding_creation",
    ...overrides,
  };
}

function markupFor(proposal: HoldingCreationProposal): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_holding",
        } as unknown as UIMessage["parts"][number],
      ],
      role: "assistant",
    },
  ];
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

beforeEach(() => {
  chatMessages = [];
});

describe("AssistantLayer · apertura del alta (#1315)", () => {
  test("prints the declared títulos, precio y comisión on the card", () => {
    const html = markupFor(altaProposal());

    expect(html).toContain("3 uds.");
    expect(html).toContain("54,545");
    // Cents kept: a 1,00 € commission may never read as a bare «1 €».
    expect(html).toContain("Comisión 1,00");
  });

  test("omits the commission line when the document declared none", () => {
    const html = markupFor(
      altaProposal({
        holding: {
          detail: "1.500 €",
          instrumentLabel: "Fondo",
          name: "Fondo Índice",
          opening: { pricePerUnit: "150 €", units: "10" },
        },
      }),
    );

    expect(html).toContain("10 uds.");
    expect(html).not.toContain("Comisión");
  });

  test("prints the coherence warning without blocking the confirm", () => {
    const html = markupFor(
      altaProposal({
        openingMismatchWarning:
          "El documento dice 200,00 €, pero 3 × 54,545 € + 1,00 € de comisión son 164,64 €.",
      }),
    );

    expect(html).toContain("El documento dice 200,00");
    expect(html).toContain("assistantWarning");
    // Informative, never blocking: the confirm button renders WITHOUT `disabled`
    // (the composer's own Enviar is disabled on an empty box — not this button).
    expect(html).toContain('<button type="button">Confirmar</button>');
  });
});
