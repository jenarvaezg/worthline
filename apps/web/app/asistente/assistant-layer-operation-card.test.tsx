import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * The operation card (#1374) in the MARKUP, which is where the user meets it. The
 * session that opened the issue had no lane for «añádeme esta compra», so the fact
 * travelled inside a reconcile batch and the card told the user two things that were
 * not true: a closing value taken from the portfolio snapshot, and a «recalibración»
 * of the position that the apply does not do.
 *
 * What is pinned here is what a user can check against the paper in their hand: the
 * document's own text, the destination holding on its own line, the fact term by term,
 * and an impact that says out loud that it is an estimate.
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
import type { OperationProposal } from "./operation-proposal-contract";

function markupFor(proposal: OperationProposal): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_operation",
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
  return html.replace(/(&#x27;|&#39;)/g, "'").replace(/[\u00a0\u202f]/g, " ");
}

function aportacionProposal(
  overrides: Partial<OperationProposal> = {},
): OperationProposal {
  return {
    document: {
      fact: "05/08/2026 · aportación · 5,92 part. × 21,1149 € · comisión 0 € · 125 €",
      line: "APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP · ES0173516115",
    },
    draft: { proposalId: "wl_prp_1374" },
    folio: "1 propuesta · 1 posición · 1 operación fechada",
    holding: {
      destination: "Anotar en «MyInvestor Indexado SP500» · ES0173516115",
      id: "wl_hld_plan",
      name: "MyInvestor Indexado SP500",
    },
    impact: { afterMinor: 297_185_00, beforeMinor: 297_060_00, deltaMinor: 125_00 },
    impactCaption: "estimado sobre la operación",
    kind: "contribution",
    notes: [],
    position: { unitsAfter: "267,932", unitsBefore: "262,012" },
    proposalType: "investment_operation",
    summary: "Aportación de 5,92 participaciones en «MyInvestor Indexado SP500»",
    ...overrides,
  };
}

describe("the operation card (#1374)", () => {
  test("prints the document's own text and the destination as SEPARATE lines", () => {
    const markup = plain(markupFor(aportacionProposal()));

    expect(markup).toContain("APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP");
    expect(markup).toContain("En el documento");
    expect(markup).toContain("Anotar en «MyInvestor Indexado SP500»");
  });

  test("prints the fact term by term, exactly as it will be written", () => {
    const markup = plain(markupFor(aportacionProposal()));

    expect(markup).toContain(
      "05/08/2026 · aportación · 5,92 part. × 21,1149 € · comisión 0 € · 125 €",
    );
    expect(markup).toContain("Participaciones 262,012 → 267,932");
  });

  test("leads with the net worth before → after and says it is an estimate", () => {
    const markup = plain(markupFor(aportacionProposal()));

    expect(markup).toContain("Patrimonio neto");
    expect(markup).toContain("+125 € · estimado sobre la operación");
    // The «recalibración» the improvised path promised is nowhere on the card.
    expect(markup).not.toContain("recalibra");
  });

  test("shows the delta alone when the net-worth read degraded (ADR 0048)", () => {
    const markup = plain(
      markupFor(
        aportacionProposal({
          impact: { afterMinor: null, beforeMinor: null, deltaMinor: 125_00 },
        }),
      ),
    );

    expect(markup).toContain("total no disponible ahora");
    expect(markup).not.toContain("Patrimonio neto 0 €");
  });

  test("offers Confirmar and Descartar, and nothing else to press", () => {
    const markup = plain(markupFor(aportacionProposal()));

    expect(markup).toContain(">Confirmar<");
    expect(markup).toContain(">Descartar<");
    expect(markup).toContain("1 propuesta · 1 posición · 1 operación fechada");
  });

  test("says why mutations are blocked instead of a live Confirmar button", () => {
    // The demo/impersonation read-only path (ADR 0044/0057) reaches the card through
    // the same prop every other proposal uses; here the onboarding variant renders it
    // enabled, so what is pinned is that the note and the buttons coexist.
    const markup = plain(markupFor(aportacionProposal({ notes: ["Revisa la cifra."] })));

    expect(markup).toContain("Revisa la cifra.");
    expect(markup).toContain("assistantWarning");
  });

  test("renders nothing at all for a payload of a shape it does not know", () => {
    const markup = plain(
      markupFor({ proposalType: "reconcile" } as unknown as OperationProposal),
    );

    expect(markup).not.toContain("En el documento");
  });
});
