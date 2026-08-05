import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The reconcile card of the session that opened #1373 (2026-08-05): a MyInvestor
 * aportación of 125,00 € over a pension plan already in the portfolio. The card was
 * unusable on four fronts at once and this file pins all four in the MARKUP, which is
 * where the user met them:
 *
 *  1. a header reading `+0 €` while the document said +125 €,
 *  2. a row that said «con movimientos» and printed none of them,
 *  3. five look-alike buttons, two of them labelled «Descartar», one of them a filled
 *     principal button that reassigned the row to the target it already had,
 *  4. the document's text and the target holding fused into one sentence, so a model
 *     that typed the wrong plan's name produced a row that agreed with itself.
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
import type { ReconcileProposal } from "./reconcile-proposal-contract";

function markupFor(proposal: ReconcileProposal): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_reconcile",
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

const SP500_TARGET = {
  holdingId: "asset-sp500",
  name: "MyInvestor Indexado SP500",
  key: "isin" as const,
  confidence: "strong" as const,
};

function aportacionProposal(): ReconcileProposal {
  return {
    draft: { proposalId: "wl_prp_1373" },
    netWorthBeforeMinor: 297_060_00,
    proposalType: "reconcile",
    rows: [
      {
        currency: "EUR",
        excluded: false,
        fidelity: "movements",
        instrument: "pension_plan",
        isin: "ES0173516115",
        match: {
          candidates: [SP500_TARGET],
          confidence: "strong",
          decision: "update",
          key: "isin",
          rowId: "row-0",
          target: "asset-sp500",
        },
        movements: [
          {
            currency: "EUR",
            date: "2026-08-05",
            kind: "contribution",
            signedAmountMinor: 12_500,
            unitPrice: 125 / 5.92,
            units: 5.92,
          },
        ],
        movementsDeltaMinor: 12_500,
        name: "MYINVESTOR INDEXADO SP 500 PP",
        rowId: "row-0",
        uncertain: false,
        valueMinor: 550_868,
      },
    ],
  };
}

beforeEach(() => {
  chatMessages = [];
});

describe("ReconcileProposalCard · la aportación de 125 € (#1373)", () => {
  test("the header adds the movement instead of reading +0 €", () => {
    const html = plain(markupFor(aportacionProposal()));

    expect(html).toContain("+125 €");
    expect(html).not.toContain("+0 €");
    expect(html).toContain("Patrimonio neto 297.060 € → 297.185 €");
  });

  test("the caption stops claiming altas in a batch that has none", () => {
    const html = plain(markupFor(aportacionProposal()));

    expect(html).toContain("estimado sobre los movimientos");
    expect(html).not.toContain("sobre las altas");
  });

  test("the row prints the movement it will write", () => {
    const html = plain(markupFor(aportacionProposal()));

    expect(html).toContain("05/08/2026 · aportación · 5,92 part. × 21,1149 € · 125 €");
  });

  test("the document text and the target holding are separate lines", () => {
    const html = plain(markupFor(aportacionProposal()));

    // Both readable at a glance: this is what makes «MYINVESTOR … SP 500 PP» vs
    // «N5396 - … Global PP» visible without opening anything.
    expect(html).toContain("MYINVESTOR INDEXADO SP 500 PP · ES0173516115");
    expect(html).toContain("Actualizar «MyInvestor Indexado SP500»");
  });

  test("the row's destination is a radio group, not a rank of commit buttons", () => {
    const html = markupFor(aportacionProposal());

    // The chosen candidate is CHECKED, not a filled button whose click does nothing.
    expect(html).toContain('type="radio"');
    expect(html).toContain('checked=""');
    // «Crear nuevo» exists, but after the candidates — never as the row's first control.
    expect(html.indexOf("Actualizar «MyInvestor Indexado SP500»")).toBeLessThan(
      html.indexOf("Crear nuevo"),
    );
  });

  test("a row taken out of the batch has inert choices, not a hidden re-include", () => {
    const excluded = aportacionProposal();
    excluded.rows[0]!.excluded = true;
    const html = markupFor(excluded);

    // Both radios disabled: the only way back is the control that says so.
    expect(html.match(/<input [^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Volver a incluir esta fila");
    expect(html).toContain("Dejar");
  });

  test("removing a row and discarding the proposal no longer share a label", () => {
    const html = plain(markupFor(aportacionProposal()));

    expect(html).toContain("Quitar esta fila del lote");
    expect(html).toContain("Descartar la propuesta");
    // The row's control is not a `Descartar` of its own any more.
    expect(html.match(/Descartar/g)).toHaveLength(1);
  });

  test("Confirmar is the only primary control on the card", () => {
    const html = plain(markupFor(aportacionProposal()));

    // The primary is the button with no class — the `.btn` base of the canon (§5).
    expect(html).toContain('<button type="button">Confirmar</button>');
    // Descartar declares itself secondary; the row's control is a text aside, and
    // deliberately NOT `.secondary` — that class names a register it does not have.
    expect(html).toContain(
      '<button class="secondary" type="button">Descartar la propuesta</button>',
    );
    expect(html).toContain(
      '<span class="assistantRowAside"><button type="button">Quitar esta fila del lote',
    );
  });
});
