/**
 * The gate's own voice (#1418). Three invariants: each note is derived from something
 * the SERVER wrote, each appears once per conversation, and «the door shut» appears at
 * the moment it shut — not at a refusal that an obedient model never triggers.
 */

import { UNSTRUCTURED_SPREADSHEET_MESSAGE } from "@web/asistente/attachment-types";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  unreadableTypedSeriesRejected,
  unvalidatedEvidenceRejected,
} from "./unvalidated-evidence-gate";
import {
  isUnreadableTypedSeriesRefusal,
  UNREADABLE_TYPED_SERIES_NOTE,
  UNVALIDATED_EVIDENCE_NOTE,
  unvalidatedEvidenceNotices,
} from "./unvalidated-evidence-notice";

/** The card worthline paints when it can read a file but not type it — the door shutting. */
function unstructuredCard(id: string): UIMessage {
  return {
    id,
    parts: [
      {
        data: {
          fileName: "cuadro.xlsx",
          result: { message: UNSTRUCTURED_SPREADSHEET_MESSAGE, status: "unrecognized" },
        },
        type: "data-attachment-extraction",
      } as unknown as UIMessage["parts"][number],
    ],
    role: "assistant",
  };
}

function refusedSeriesTurn(id: string): UIMessage {
  return {
    id,
    parts: [
      {
        output: unreadableTypedSeriesRejected(),
        state: "output-available",
        toolCallId: `call-${id}`,
        type: "tool-propose_balance_history_import",
      } as unknown as UIMessage["parts"][number],
    ],
    role: "assistant",
  };
}

function proseTurn(id: string, text: string): UIMessage {
  return { id, parts: [{ text, type: "text" }], role: "assistant" };
}

describe("«the door shut» (#1418)", () => {
  it("marks the card that shut it, before the user does any work", () => {
    // Anchored here and NOT on a refused tool call: the prompt tells the model not to
    // offer a bulk import, so an obedient model is never refused and a refusal-anchored
    // note would never fire — which is the turn that filed this ticket.
    expect(
      unvalidatedEvidenceNotices([unstructuredCard("a1"), proseTurn("a2", "Te cuento.")])
        .gateClosed,
    ).toBe("a1");
  });

  it("marks only the FIRST one — the note is not a telling-off", () => {
    expect(
      unvalidatedEvidenceNotices([unstructuredCard("a1"), unstructuredCard("a2")])
        .gateClosed,
    ).toBe("a1");
  });

  it("marks nothing on a conversation that never put an unreadable file on the table", () => {
    expect(unvalidatedEvidenceNotices([proseTurn("a1", "Hola.")]).gateClosed).toBeNull();
    expect(unvalidatedEvidenceNotices([]).gateClosed).toBeNull();
  });
});

describe("«you wrote it and I could not read it» (#1418)", () => {
  it("marks the turn whose refusal says so", () => {
    expect(
      unvalidatedEvidenceNotices([unstructuredCard("a1"), refusedSeriesTurn("a2")])
        .unreadableSeries,
    ).toBe("a2");
  });

  it("marks only the first, however many pastes fail", () => {
    expect(
      unvalidatedEvidenceNotices([refusedSeriesTurn("a1"), refusedSeriesTurn("a2")])
        .unreadableSeries,
    ).toBe("a1");
  });

  it("does not fire on the ORDINARY gate refusal", () => {
    // Different question, different note: that one is «the door is shut», already said
    // under the card. Only a paste worthline failed on earns this one.
    const gated: UIMessage = {
      id: "a1",
      parts: [
        {
          output: unvalidatedEvidenceRejected(),
          state: "output-available",
          toolCallId: "call-1",
          type: "tool-propose_reconcile",
        } as unknown as UIMessage["parts"][number],
      ],
      role: "assistant",
    };

    expect(unvalidatedEvidenceNotices([gated]).unreadableSeries).toBeNull();
  });
});

describe("isUnreadableTypedSeriesRefusal (#1418)", () => {
  it("recognizes the refusal by the key the server wrote", () => {
    expect(isUnreadableTypedSeriesRefusal(unreadableTypedSeriesRejected())).toBe(true);
  });

  it("ignores every other outcome, prose included", () => {
    expect(isUnreadableTypedSeriesRefusal(unvalidatedEvidenceRejected())).toBe(false);
    expect(isUnreadableTypedSeriesRefusal({ error: "premium_required" })).toBe(false);
    expect(
      isUnreadableTypedSeriesRefusal({ proposalType: "balance_history_import" }),
    ).toBe(false);
    expect(isUnreadableTypedSeriesRefusal("unreadable_typed_series")).toBe(false);
    expect(isUnreadableTypedSeriesRefusal(["unreadable_typed_series"])).toBe(false);
    expect(isUnreadableTypedSeriesRefusal(null)).toBe(false);
    expect(isUnreadableTypedSeriesRefusal(undefined)).toBe(false);
  });
});

describe("the notes' copy (#1418)", () => {
  it("opens the door that IS open and routes only what really has a route", () => {
    expect(UNVALIDATED_EVIDENCE_NOTE).toMatch(/histórico de saldos/i);
    expect(UNVALIDATED_EVIDENCE_NOTE).toMatch(/una línea por fecha/i);
    // The statement importer is named for positions and movements — never for the debt
    // history, which has no deterministic surface at all.
    expect(UNVALIDATED_EVIDENCE_NOTE).toContain("/patrimonio/importar-extracto");
    expect(UNVALIDATED_EVIDENCE_NOTE).toMatch(/posiciones y movimientos/i);
  });

  it("never sends the user back to the upload that shut the door", () => {
    expect(UNVALIDATED_EVIDENCE_NOTE).not.toMatch(/vuelve a subir|súbelo otra vez/i);
  });

  it("tells a failed paste that worthline tried, and does not ask for it again", () => {
    expect(UNREADABLE_TYPED_SERIES_NOTE).toMatch(/no he sabido interpretarla/i);
    expect(UNREADABLE_TYPED_SERIES_NOTE).toMatch(/no has perdido el trabajo/i);
    expect(UNREADABLE_TYPED_SERIES_NOTE).not.toBe(UNVALIDATED_EVIDENCE_NOTE);
  });
});
