/**
 * The gate's own voice (#1418). The invariant: the note is derived from the SERVER'S
 * tool output, appears once per conversation, and never appears on a thread nothing
 * was refused in.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { unvalidatedEvidenceCapReached } from "./unvalidated-evidence-gate";
import {
  isUnvalidatedEvidenceRefusal,
  messageWithUnvalidatedEvidenceNotice,
  UNVALIDATED_EVIDENCE_NOTE,
} from "./unvalidated-evidence-notice";

function refusedTurn(id: string): UIMessage {
  return {
    id,
    parts: [
      {
        output: { error: "unvalidated_evidence", message: "…" },
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

describe("isUnvalidatedEvidenceRefusal (#1418)", () => {
  it("recognizes the gate's refusal by its key", () => {
    expect(isUnvalidatedEvidenceRefusal({ error: "unvalidated_evidence" })).toBe(true);
  });

  it("ignores the per-turn cap: that turn did prepare a proposal", () => {
    expect(isUnvalidatedEvidenceRefusal(unvalidatedEvidenceCapReached())).toBe(false);
  });

  it("ignores every other outcome, prose included", () => {
    expect(isUnvalidatedEvidenceRefusal({ error: "premium_required" })).toBe(false);
    expect(isUnvalidatedEvidenceRefusal({ proposalType: "balance_history_import" })).toBe(
      false,
    );
    expect(isUnvalidatedEvidenceRefusal("unvalidated_evidence")).toBe(false);
    expect(isUnvalidatedEvidenceRefusal(["unvalidated_evidence"])).toBe(false);
    expect(isUnvalidatedEvidenceRefusal(null)).toBe(false);
    expect(isUnvalidatedEvidenceRefusal(undefined)).toBe(false);
  });
});

describe("messageWithUnvalidatedEvidenceNotice (#1418)", () => {
  it("marks the turn whose tool the gate refused", () => {
    expect(
      messageWithUnvalidatedEvidenceNotice([
        proseTurn("a1", "Te cuento lo que veo."),
        refusedTurn("a2"),
      ]),
    ).toBe("a2");
  });

  it("marks only the FIRST one — the note is not a telling-off", () => {
    expect(
      messageWithUnvalidatedEvidenceNotice([
        refusedTurn("a1"),
        refusedTurn("a2"),
        refusedTurn("a3"),
      ]),
    ).toBe("a1");
  });

  it("marks nothing when no tool was refused", () => {
    expect(
      messageWithUnvalidatedEvidenceNotice([proseTurn("a1", "unvalidated_evidence")]),
    ).toBeNull();
    expect(messageWithUnvalidatedEvidenceNotice([])).toBeNull();
  });
});

describe("the note's copy (#1418)", () => {
  it("names the door that IS open and the route for everything else", () => {
    expect(UNVALIDATED_EVIDENCE_NOTE).toMatch(/histórico de saldos/i);
    expect(UNVALIDATED_EVIDENCE_NOTE).toMatch(/una línea por fecha/i);
    expect(UNVALIDATED_EVIDENCE_NOTE).toContain("/patrimonio/importar-extracto");
  });

  it("never sends the user back to the upload that opened the gate", () => {
    expect(UNVALIDATED_EVIDENCE_NOTE).not.toMatch(/vuelve a subir|súbelo otra vez/i);
  });
});
