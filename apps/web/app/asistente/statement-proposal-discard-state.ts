export type StatementProposalDiscardState =
  | { status: "idle" }
  | { status: "discarding" }
  | { status: "discarded" }
  | { status: "error"; message: string };

export type StatementProposalDiscardEvent =
  | { type: "start" }
  | { type: "succeed" }
  | { type: "fail"; message: string };

export const INITIAL_STATEMENT_PROPOSAL_DISCARD_STATE: StatementProposalDiscardState = {
  status: "idle",
};

export function reduceStatementProposalDiscard(
  state: StatementProposalDiscardState,
  event: StatementProposalDiscardEvent,
): StatementProposalDiscardState {
  switch (event.type) {
    case "start":
      return state.status === "idle" || state.status === "error"
        ? { status: "discarding" }
        : state;
    case "succeed":
      return state.status === "discarding" ? { status: "discarded" } : state;
    case "fail":
      return state.status === "discarding"
        ? { status: "error", message: event.message }
        : state;
  }
}
