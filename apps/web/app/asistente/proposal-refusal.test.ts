import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  fabricatedProposalNote,
  NO_PROPOSAL_RETURNED_NOTE,
  userFacingRefusalIn,
} from "./fabricated-proposal";
import {
  proposalCardPart,
  rejectedProposalPart,
  userRefusedProposalPart,
} from "./proposal-part-fixtures";
import { modelRefusal, userFacingRefusal, userRefusal } from "./proposal-refusal";

function assistantTurn(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", parts, role: "assistant" };
}

describe("userFacingRefusal", () => {
  it("hands back the sentence a lane wrote for the user", () => {
    expect(userFacingRefusal(userRefusal("gap", "Dime el día."))).toBe("Dime el día.");
  });

  it("keeps a sentence written at the model off the screen", () => {
    expect(userFacingRefusal(modelRefusal("mismatch", "y tú pasas 6"))).toBeNull();
  });

  it("stays silent for a refusal that declares no audience", () => {
    // The safe default that lets the lanes adopt this one at a time: what the user
    // reads is the note that already shipped, never a sentence nobody vouched for.
    expect(userFacingRefusal({ error: "operation_document_required" })).toBeNull();
  });

  it("stays silent for a proposal, and for anything that is not a refusal", () => {
    expect(userFacingRefusal({ proposalType: "correction" })).toBeNull();
    expect(userFacingRefusal(null)).toBeNull();
    expect(userFacingRefusal("no")).toBeNull();
    expect(userFacingRefusal({ audience: "user", message: "   " })).toBeNull();
  });
});

describe("userFacingRefusalIn", () => {
  it("finds the refusal among a turn's proposal parts", () => {
    expect(userFacingRefusalIn(assistantTurn([userRefusedProposalPart()]))).toContain(
      "no he visto la fecha",
    );
  });

  it("says nothing about a turn whose lane painted a card", () => {
    expect(userFacingRefusalIn(assistantTurn([proposalCardPart()]))).toBeNull();
  });

  it("says nothing when the refusal declared no audience", () => {
    expect(userFacingRefusalIn(assistantTurn([rejectedProposalPart()]))).toBeNull();
  });
});

describe("fabricatedProposalNote", () => {
  it("quotes the refusal, attributes it, and keeps what the note always asserted", () => {
    const note = fabricatedProposalNote("rejected", "Dime el día.");
    expect(note).toContain("worthline no la ha preparado");
    expect(note).toContain("«Dime el día.»");
    expect(note).toContain("no lleva ninguna propuesta");
    expect(note).toContain("no aplica nada");
  });

  it("falls back to the sentence of #1468 with no refusal to quote", () => {
    expect(fabricatedProposalNote("rejected")).toBe(NO_PROPOSAL_RETURNED_NOTE);
    expect(fabricatedProposalNote("interrupted", null)).toBe(NO_PROPOSAL_RETURNED_NOTE);
  });

  it("never quotes anything next to a ceremony that asked no lane at all", () => {
    // There is no refusal to cite in a `no-call` turn, and a note that invented one
    // would be the very thing this corner exists to stop.
    expect(fabricatedProposalNote("no-call", "Dime el día.")).not.toContain(
      "Dime el día",
    );
  });
});
