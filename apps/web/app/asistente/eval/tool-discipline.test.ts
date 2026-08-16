import { describe, expect, test } from "vitest";

import type { AssistantAnswer } from "./graders";
import {
  asksForTheMissingFigure,
  calledProposalTool,
  fakesProposalCeremony,
  proposedHoldingLabels,
  reachedForBulkImportTool,
  ungroundedProposalIds,
} from "./tool-discipline";

function answer(over: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return { text: "", toolCalls: [], toolResults: [], quickActions: [], ...over };
}

/** What a read of the demo `familia` persona actually hands back, trimmed. */
const CONTEXT_OUTPUT = {
  holdings: [
    { id: "liability_familia_car", label: "Préstamo coche" },
    { id: "asset_familia_etf", label: "Cartera indexada familiar" },
  ],
};

describe("calledProposalTool", () => {
  test("sees a proposal tool and ignores reads and suggestions", () => {
    expect(
      calledProposalTool(
        answer({ toolCalls: [{ input: {}, name: "propose_correction" }] }),
      ),
    ).toBe(true);
    expect(
      calledProposalTool(
        answer({
          toolCalls: [
            { input: {}, name: "get_financial_context" },
            { input: {}, name: "suggest_actions" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("fakesProposalCeremony", () => {
  test("catches the prose imitation of the card (#1262)", () => {
    expect(
      fakesProposalCeremony(
        answer({ text: "He preparado la propuesta para dejar el saldo en 6.850 €." }),
      ),
    ).toBe(true);
  });

  test("stays silent when the turn really called the tool", () => {
    expect(
      fakesProposalCeremony(
        answer({
          text: "He preparado la propuesta para dejar el saldo en 6.850 €.",
          toolCalls: [{ input: {}, name: "propose_correction" }],
        }),
      ),
    ).toBe(false);
  });

  test("stays silent on an honest offer to prepare one", () => {
    expect(
      fakesProposalCeremony(answer({ text: "Si quieres, te preparo la propuesta." })),
    ).toBe(false);
  });
});

describe("reachedForBulkImportTool", () => {
  test("names the tools the unvalidated-evidence frontier rejects (#1248)", () => {
    for (const name of [
      "propose_reconstruction",
      "propose_statement_import",
      "propose_reconcile",
      "propose_balance_history_import",
      "propose_mixed_document_import",
    ]) {
      expect(
        reachedForBulkImportTool(answer({ toolCalls: [{ input: {}, name }] })),
        name,
      ).toBe(true);
    }
  });

  test("a single-fact proposal is not a bulk import", () => {
    expect(
      reachedForBulkImportTool(
        answer({ toolCalls: [{ input: {}, name: "propose_correction" }] }),
      ),
    ).toBe(false);
  });
});

describe("ungroundedProposalIds", () => {
  test("accepts an id that came out of a read in the same turn", () => {
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [
            { input: {}, name: "get_financial_context" },
            {
              input: { holdingId: "liability_familia_car" },
              name: "propose_correction",
            },
          ],
          toolResults: [{ name: "get_financial_context", output: CONTEXT_OUTPUT }],
        }),
      ),
    ).toEqual([]);
  });

  test("reports the invented id (#1263)", () => {
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_hld_inventado" }, name: "propose_correction" },
          ],
          toolResults: [{ name: "get_financial_context", output: CONTEXT_OUTPUT }],
        }),
      ),
    ).toEqual(["wl_hld_inventado"]);
  });

  test("a proposal with no read at all grounds nothing", () => {
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [
            { input: { holdingId: "liability_familia_car" }, name: "propose_correction" },
          ],
        }),
      ),
    ).toEqual(["liability_familia_car"]);
  });

  test("looks at nested id fields, not only the top level", () => {
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [
            {
              input: { correction: { holdingId: "asset_inventado" }, rows: [] },
              name: "propose_correction",
            },
          ],
          toolResults: [{ name: "get_financial_context", output: CONTEXT_OUTPUT }],
        }),
      ),
    ).toEqual(["asset_inventado"]);
  });

  test("another proposal's echo does not launder an id", () => {
    // Only READS ground an identifier. A proposal tool's own output repeats what
    // the model just sent, so counting it would make every invention self-proving.
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_hld_inventado" }, name: "propose_correction" },
          ],
          toolResults: [
            { name: "propose_correction", output: { holdingId: "wl_hld_inventado" } },
          ],
        }),
      ),
    ).toEqual(["wl_hld_inventado"]);
  });

  test("ignores ids the proposal never carried", () => {
    expect(ungroundedProposalIds(answer())).toEqual([]);
  });

  test("a blank id is a missing argument, not an invented one", () => {
    // And it must never read as grounded either: "" is a substring of every read.
    expect(
      ungroundedProposalIds(
        answer({
          toolCalls: [{ input: { holdingId: "  " }, name: "propose_correction" }],
          toolResults: [{ name: "get_financial_context", output: CONTEXT_OUTPUT }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("asksForTheMissingFigure", () => {
  test("recognises the turn that asks instead of inventing", () => {
    for (const text of [
      "¿Cuál es el saldo real que marca el banco?",
      "Dime el importe exacto y te preparo la propuesta.",
      "Para corregirlo necesito la cifra actual. ¿Cuánto queda?",
    ]) {
      expect(asksForTheMissingFigure(text), text).toBe(true);
    }
  });

  test("does not count a turn that simply states a figure", () => {
    expect(asksForTheMissingFigure("El saldo pendiente es de 7.200 €.")).toBe(false);
  });
});

describe("proposedHoldingLabels", () => {
  /** The two siblings of the demo `inversor` persona (#1376), as a read hands them back. */
  const SIBLINGS = {
    matches: [
      { id: "wl_hld_world", label: "ETF MSCI World", object: "holding" },
      { id: "wl_hld_small", label: "ETF MSCI World Small Cap", object: "holding" },
    ],
  };

  test("names the holding a proposal pointed at, as the read named it", () => {
    expect(
      proposedHoldingLabels(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_hld_small" }, name: "propose_operation" },
          ],
          toolResults: [{ name: "find_holdings", output: SIBLINGS }],
        }),
      ),
    ).toEqual(["ETF MSCI World Small Cap"]);
  });

  test("reports the sibling when the proposal jumped to it", () => {
    // The failure this exists for: a real fact, written onto the wrong position. Both
    // labels are in the same read, so nothing but judgement separates them.
    expect(
      proposedHoldingLabels(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_hld_world" }, name: "propose_operation" },
          ],
          toolResults: [{ name: "find_holdings", output: SIBLINGS }],
        }),
      ),
    ).toEqual(["ETF MSCI World"]);
  });

  test("says nothing about an id no read ever surfaced", () => {
    // Deliberately silent rather than wrong: an invented id is `ungroundedProposalIds`'
    // finding, and counting it twice would report one defect as two.
    expect(
      proposedHoldingLabels(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_hld_inventado" }, name: "propose_operation" },
          ],
          toolResults: [{ name: "find_holdings", output: SIBLINGS }],
        }),
      ),
    ).toEqual([]);
  });

  test("ignores the holdings a read named but no proposal touched", () => {
    expect(
      proposedHoldingLabels(
        answer({ toolResults: [{ name: "find_holdings", output: SIBLINGS }] }),
      ),
    ).toEqual([]);
  });
});

describe("proposedHoldingLabels — what is not a holding", () => {
  test("ignores an id/label pair that belongs to something else", () => {
    // Scopes, members, connected sources and payouts all carry `id` + `label`. Naming
    // one of them as a write's destination would report the wrong thing entirely, so
    // the `object` tag is what qualifies a row here.
    expect(
      proposedHoldingLabels(
        answer({
          toolCalls: [
            { input: { holdingId: "wl_scp_hogar" }, name: "propose_operation" },
          ],
          toolResults: [
            {
              name: "list_scopes",
              output: {
                scopes: [{ id: "wl_scp_hogar", label: "Hogar", object: "scope" }],
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
