import { describe, expect, it } from "vitest";

import {
  INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
  reduceStatementProposalDiscard,
} from "./statement-proposal-discard-state";

describe("statement proposal discard state", () => {
  it("optimistically hides the card, then settles as discarded", () => {
    const discarding = reduceStatementProposalDiscard(
      INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
      { type: "start" },
    );
    expect(discarding).toEqual({ status: "discarding" });
    expect(reduceStatementProposalDiscard(discarding, { type: "succeed" })).toEqual({
      status: "discarded",
    });
  });

  it("restores the card with an error when persistence fails", () => {
    const discarding = reduceStatementProposalDiscard(
      INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE,
      { type: "start" },
    );
    expect(
      reduceStatementProposalDiscard(discarding, {
        type: "fail",
        message: "No se pudo descartar.",
      }),
    ).toEqual({ status: "error", message: "No se pudo descartar." });
  });
});
