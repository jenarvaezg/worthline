import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * The traspaso card (#1482) in the MARKUP, which is where the user meets it.
 *
 * What is pinned here is the ceremony this lane rests on. The importe and the date were
 * read by worthline off the user's OWN message, so the card has to print them back
 * before anything else: that echo is the only place a misparse can be caught, and what
 * it guards is two rows plus an inherited cost moving real capital. Then both halves —
 * because the two unit counts are unrelated figures — and, in words, the two things a
 * traspaso does NOT do.
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
  usePathname: () => "/asistente",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";
import type { TransferProposal } from "./transfer-proposal-contract";

function markupFor(proposal: TransferProposal): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_transfer",
        } as unknown as UIMessage["parts"][number],
      ],
      role: "assistant",
    },
  ];
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

/** `Intl` uses a non-breaking space before €; assertions read the plain text. */
function plain(html: string): string {
  return html.replace(/(&#x27;|&#39;)/g, "'").replace(/[  ]/g, " ");
}

function transferProposal(overrides: Partial<TransferProposal> = {}): TransferProposal {
  return {
    destination: {
      movementLine: "50,98069 part. × 14,5 € · 739,22 €",
      positionLine: "Entran en «Cartera Permanente PP»: 0 → 50,98069 participaciones",
    },
    dictated: "14/08/2026 · 739,22 €",
    draft: { proposalId: "wl_prp_1482" },
    folio: "1 propuesta · 1 traspaso · 2 apuntes atados",
    impact: { afterMinor: 297_060_00, beforeMinor: 297_060_00, deltaMinor: 0 },
    impactCaption: "estimado sobre el traspaso",
    inheritedCost: "Coste de adquisición que viaja: 616,02 €",
    notes: [
      "Un traspaso no realiza plusvalía ni consume cupo de aportación: el coste de " +
        "adquisición viaja con las participaciones.",
    ],
    origin: {
      movementLine: "61,601667 part. × 12 € · 739,22 €",
      positionLine: "Salen de «Indexado PP»: 100 → 38,398333 participaciones",
    },
    proposalType: "investment_transfer",
    summary:
      "Traspaso de 61,601667 participaciones de «Indexado PP» a «Cartera Permanente PP»",
    ...overrides,
  };
}

describe("the traspaso card (#1482)", () => {
  test("echoes what worthline read in the message, labelled as such", () => {
    const markup = plain(markupFor(transferProposal()));

    expect(markup).toContain("14/08/2026 · 739,22 €");
    expect(markup).toContain("Lo que he leído en tu mensaje");
  });

  test("prints BOTH halves and both positions: two unrelated unit counts", () => {
    const markup = plain(markupFor(transferProposal()));

    expect(markup).toContain("Salen de «Indexado PP»: 100 → 38,398333 participaciones");
    expect(markup).toContain("61,601667 part. × 12 €");
    expect(markup).toContain(
      "Entran en «Cartera Permanente PP»: 0 → 50,98069 participaciones",
    );
    expect(markup).toContain("50,98069 part. × 14,5 €");
    expect(markup).toContain("Coste de adquisición que viaja: 616,02 €");
  });

  test("says in words that no plusvalía is realized and no cupo is spent", () => {
    const markup = plain(markupFor(transferProposal()));

    expect(markup).toContain("no realiza plusvalía ni consume cupo de aportación");
    // A zero delta alone would read as «nothing happened»; the sentence is the point.
    expect(markup).toContain("estimado sobre el traspaso");
  });

  test("shows the delta alone when the net-worth read degraded (ADR 0048)", () => {
    const markup = plain(
      markupFor(
        transferProposal({
          impact: { afterMinor: null, beforeMinor: null, deltaMinor: 0 },
        }),
      ),
    );

    expect(markup).toContain("total no disponible ahora");
  });

  test("offers Confirmar and Descartar, and nothing else to press", () => {
    const markup = plain(markupFor(transferProposal()));

    expect(markup).toContain(">Confirmar<");
    expect(markup).toContain(">Descartar<");
    expect(markup).toContain("1 propuesta · 1 traspaso · 2 apuntes atados");
  });

  test("renders nothing at all for a payload of a shape it does not know", () => {
    const markup = plain(
      markupFor({ proposalType: "reconcile" } as unknown as TransferProposal),
    );

    expect(markup).not.toContain("Lo que he leído en tu mensaje");
  });
});
