/**
 * The question the guard was getting wrong (#1468): «did a card get PAINTED?», not
 * «was a propose_* tool called?». These tests pin the table both readers share, and
 * the guardian that stops a new lane from slipping past it unregistered.
 */

import { createChatTools } from "@web/asistente/chat-tools";
import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  PROPOSAL_CARD_PARSERS,
  proposalCardFrom,
  proposalCardInPart,
  rendersProposalCard,
} from "./proposal-card-presence";
import { correctionProposalOutput, toolPart } from "./proposal-part-fixtures";

describe("proposalCardFrom (#1468)", () => {
  test("unfolds the output a lane really returned", () => {
    const card = proposalCardFrom("propose_correction", correctionProposalOutput());

    expect(card).not.toBeNull();
    expect(card?.kind).toBe("correction");
  });

  test("says no card when the lane REJECTED the call", () => {
    // Jorge's turn (#1468): a dictated operation with no document behind it, so
    // every path returned an error and nothing was ever painted.
    expect(
      proposalCardFrom("propose_operation", { error: "operation_document_required" }),
    ).toBeNull();
  });

  test("says no card for a payload that does not parse as its lane's proposal", () => {
    // The shape the old guard was happy with: an object that mentions a proposal
    // id and nothing the card needs.
    expect(
      proposalCardFrom("propose_correction", {
        mode: "declare_balance",
        proposalId: "p1",
      }),
    ).toBeNull();
  });

  test("ignores a tool that is not a proposal lane at all", () => {
    expect(proposalCardFrom("get_financial_context", { netWorthMinor: 1 })).toBeNull();
  });
});

describe("proposalCardInPart (#1468)", () => {
  test("reads a finished proposal call", () => {
    const part = toolPart("tool-propose_correction", {
      output: correctionProposalOutput(),
      state: "output-available",
    });

    expect(rendersProposalCard(part)).toBe(true);
    expect(proposalCardInPart(part)?.kind).toBe("correction");
  });

  test("a rejected call renders NOTHING, whatever its name says", () => {
    const part = toolPart("tool-propose_operation", {
      output: { error: "operation_document_required" },
      state: "output-available",
    });

    expect(rendersProposalCard(part)).toBe(false);
  });

  test("the tool's own error state renders nothing", () => {
    // `output-error` carries `errorText` and no output at all (ai's ToolUIPart).
    expect(
      rendersProposalCard(
        toolPart("tool-propose_correction", {
          errorText: "boom",
          state: "output-error",
        }),
      ),
    ).toBe(false);
    // And the state decides even if some payload rode along: a failed call never
    // painted a card, so the guard must not read one out of it.
    expect(
      rendersProposalCard(
        toolPart("tool-propose_correction", {
          errorText: "boom",
          output: correctionProposalOutput(),
          state: "output-error",
        }),
      ),
    ).toBe(false);
  });

  test("a call that never produced an output renders nothing", () => {
    expect(
      rendersProposalCard(
        toolPart("tool-propose_early_repayment", { state: "input-streaming" }),
      ),
    ).toBe(false);
  });

  test("reads a dynamic tool part by its toolName", () => {
    const part = {
      input: {},
      output: correctionProposalOutput(),
      state: "output-available",
      toolCallId: "call-1",
      toolName: "propose_correction",
      type: "dynamic-tool",
    } as unknown as UIMessage["parts"][number];

    expect(rendersProposalCard(part)).toBe(true);
  });

  test("a text part is not a tool call", () => {
    expect(
      rendersProposalCard({ text: "He preparado la propuesta.", type: "text" }),
    ).toBe(false);
  });
});

/**
 * The guardian (#1468). A `propose_*` lane nobody registers here would count as
 * «has a card» in the fabricated-ceremony guard without ever painting one — the
 * exact silence this table exists to break. Same shape as the guardian the
 * unvalidated-evidence frontier already runs over the same tool catalog (#1248).
 */
describe("every propose_* chat tool declares how its card is read (#1468)", () => {
  const tools = createChatTools({
    runWithStore: async () => {
      throw new Error("no store needed to enumerate the tool set");
    },
    asOf: "2026-08-19",
  });
  const proposalTools = Object.keys(tools).filter((name) => name.startsWith("propose_"));

  test("the catalog is enumerable", () => {
    expect(proposalTools.length).toBeGreaterThan(0);
  });

  test("no proposal lane is missing from the table", () => {
    expect(proposalTools.filter((name) => !(name in PROPOSAL_CARD_PARSERS))).toEqual([]);
  });

  test("nothing in the table has since left the catalog", () => {
    expect(Object.keys(PROPOSAL_CARD_PARSERS).filter((name) => !(name in tools))).toEqual(
      [],
    );
  });
});
