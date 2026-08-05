import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The same instrument at two brokers (#1331). The matcher stops resolving a shared
 * ISIN on its own (proven in `holding-matcher.test.ts` and `reconcile-plan.test.ts`);
 * what this file proves is that the AMBIGUITY REACHES THE MARKUP — a row that reads
 * «Actualizar «X»» with nothing else would send a user straight to Confirmar without
 * ever learning that two holdings claim that identifier.
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
import {
  HOLDING_CREATION_FOLIO,
  type HoldingCreationProposal,
} from "./holding-creation-proposal-contract";
import type { ReconcileProposal } from "./reconcile-proposal-contract";

function markupFor(proposal: unknown, tool: string): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: `tool-${tool}`,
        } as unknown as UIMessage["parts"][number],
      ],
      role: "assistant",
    },
  ];
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

const LIVE = {
  holdingId: "asset-live",
  name: "Vanguard US Equity Index Fund EUR Hedged",
  key: "isin" as const,
  confidence: "strong" as const,
};
const CLOSED = {
  holdingId: "asset-closed",
  name: "Vanguard U.S. 500 Stk Idx € H Acc",
  key: "isin" as const,
  confidence: "strong" as const,
};

function reconcileProposal(ambiguous: boolean): ReconcileProposal {
  return {
    draft: { proposalId: "wl_prp_1331" },
    netWorthBeforeMinor: 1_000_000,
    proposalType: "reconcile",
    rows: [
      {
        currency: "EUR",
        excluded: false,
        fidelity: "movements",
        instrument: "fund",
        isin: "IE00B1G3DH73",
        match: {
          candidates: ambiguous ? [LIVE, CLOSED] : [LIVE],
          confidence: ambiguous ? "weak" : "strong",
          decision: "update",
          key: "isin",
          rowId: "row-0",
          target: "asset-live",
          ...(ambiguous ? { ambiguous: true } : {}),
        },
        movements: [
          {
            currency: "EUR",
            date: "2026-07-01",
            kind: "buy",
            signedAmountMinor: 100_000,
          },
        ],
        movementsDeltaMinor: 100_000,
        name: "Vanguard US Equity Index Fund EUR Hedged",
        rowId: "row-0",
        uncertain: false,
        valueMinor: 660_000,
      },
    ],
  };
}

beforeEach(() => {
  chatMessages = [];
});

describe("ReconcileProposalCard · dos holdings con el mismo ISIN (#1331)", () => {
  test("says how many holdings share the identifier and asks the user to review", () => {
    const html = markupFor(reconcileProposal(true), "propose_reconcile");

    expect(html).toContain("2 holdings con el mismo identificador");
    expect(html).toContain("revisa cuál actualizas");
    // Both claimants are offered, so the review can be resolved in place.
    expect(html).toContain("Vanguard US Equity Index Fund EUR Hedged");
    expect(html).toContain("Vanguard U.S. 500 Stk Idx");
  });

  test("an unambiguous row stays clean — no review noise on a resolved match", () => {
    const html = markupFor(reconcileProposal(false), "propose_reconcile");

    expect(html).not.toContain("revisa cuál actualizas");
    expect(html).toContain("Actualizar «Vanguard US Equity Index Fund EUR Hedged»");
  });
});

describe("HoldingCreationProposalCard · el duplicado ya no es siempre uno (#1331)", () => {
  function alta(
    duplicate: HoldingCreationProposal["duplicate"],
  ): HoldingCreationProposal {
    return {
      draft: { proposalId: "wl_prp_alta" },
      family: "investment",
      folio: HOLDING_CREATION_FOLIO,
      holding: { detail: "6.600 €", instrumentLabel: "Fondo", name: "Vanguard US 500" },
      impact: { afterMinor: 660_000, beforeMinor: 0, deltaMinor: 660_000 },
      proposalType: "holding_creation",
      ...(duplicate ? { duplicate } : {}),
    };
  }

  test("counts the other look-alikes instead of naming just one", () => {
    const html = markupFor(
      alta({
        confidence: "strong",
        name: "Vanguard US Equity Index Fund EUR Hedged",
        otherCandidates: 1,
      }),
      "propose_holding",
    );

    expect(html).toContain("y 1 más que se le parece");
    // Still informative: the alta remains confirmable.
    expect(html).toContain("Puedes crearlo igualmente si es otro distinto");
  });

  test("a single duplicate reads exactly as before", () => {
    const html = markupFor(
      alta({ confidence: "strong", name: "Vanguard US Equity Index Fund EUR Hedged" }),
      "propose_holding",
    );

    expect(html).not.toContain("que se le parece");
  });
});
