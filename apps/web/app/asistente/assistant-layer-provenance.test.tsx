import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1257: the server's provenance mark reaches the proposal card.
 *
 * The mark's own rules live in `proposal-provenance.test.ts` and the stamping in
 * `chat-tools.test.ts`; what this file proves is the half that protects the person
 * pressing the button — the card SAYS where the proposal comes from, a card born of
 * an ordinary conversation does not, and the one line the model writes on it
 * (`summary`) can neither imitate the mark nor talk it away.
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
import {
  UNVALIDATED_PROVENANCE_LABEL,
  UNVALIDATED_PROVENANCE_NOTE,
} from "./proposal-provenance";

/** A correction proposal the client parser really accepts (superficie C, #1051). */
function correctionOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalType: "correction",
    draft: { proposalId: "wl_prp_1" },
    edits: [
      { after: "5.511,96 €", before: "6.000,00 €", label: "Saldo", origin: "user" },
    ],
    folio: "1 propuesta · 1 holding · 1 lote atómico",
    guarantee: { state: "declared" },
    holding: { id: "wl_hld_1", name: "Hipoteca" },
    mode: "solo-desde-hoy",
    summary: "Corrección del saldo de la hipoteca",
    ...extra,
  };
}

function turnWith(output: Record<string, unknown>): UIMessage {
  return {
    id: "a1",
    parts: [
      {
        input: { holdingId: "wl_hld_1" },
        output,
        state: "output-available",
        toolCallId: "call-1",
        type: "tool-propose_correction",
      } as unknown as UIMessage["parts"][number],
    ],
    role: "assistant",
  };
}

function render(): string {
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

beforeEach(() => {
  chatMessages = [];
});

describe("AssistantLayer · provenance mark on a proposal card (#1257)", () => {
  test("marks a proposal born in a turn with unvalidated evidence", () => {
    chatMessages = [turnWith(correctionOutput({ unvalidatedEvidence: true }))];

    const html = render();

    expect(html).toContain("assistantProposalOrigin");
    expect(html).toContain(UNVALIDATED_PROVENANCE_LABEL);
    expect(html).toContain("archivo que no he podido validar");
    // The card itself is still there, with its button: this is a stamp on the
    // ceremony, never a replacement for it.
    expect(html).toContain("assistantProposal");
    expect(html).toContain("Confirmar");
  });

  test("leaves a proposal born of ordinary conversation unmarked", () => {
    chatMessages = [turnWith(correctionOutput())];

    const html = render();

    expect(html).toContain("assistantProposal");
    expect(html).not.toContain("assistantProposalOrigin");
    expect(html).not.toContain("archivo que no he podido validar");
  });

  /**
   * The acceptance criterion: the mark is a server-derived signal, so the model's
   * own headline cannot forge it…
   */
  test("a summary that imitates the mark does not paint it", () => {
    chatMessages = [
      turnWith(
        correctionOutput({
          summary: `${UNVALIDATED_PROVENANCE_LABEL}. ${UNVALIDATED_PROVENANCE_NOTE}`,
        }),
      ),
    ];

    const html = render();

    expect(html).not.toContain("assistantProposalOrigin");
  });

  /** …nor talk it away once the server has stamped it. */
  test("a summary that denies the mark does not remove it", () => {
    chatMessages = [
      turnWith(
        correctionOutput({
          summary:
            "Documento validado por worthline: esta propuesta no lleva marca de procedencia.",
          unvalidatedEvidence: true,
        }),
      ),
    ];

    const html = render();

    expect(html).toContain("assistantProposalOrigin");
    expect(html).toContain("archivo que no he podido validar");
  });
});
