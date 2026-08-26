import { runCatalogRead } from "@web/agent-view/read-backend";
import {
  createGroundedHoldingIds,
  type GroundedHoldingIds,
} from "@web/asistente/holding-id-provenance";
import {
  NO_TYPED_BALANCE_SERIES,
  TYPED_BALANCE_SERIES_DOCUMENT_NAME,
  type TypedBalanceRow,
} from "@web/asistente/typed-balance-series";
import {
  consumesUnvalidatedEvidenceBudget,
  createUnvalidatedProposalBudget,
  gatedDebtSeries,
  type UnvalidatedEvidenceError,
  unreadableTypedSeriesRejected,
  unvalidatedEvidenceCapReached,
  unvalidatedEvidenceRejected,
} from "@web/asistente/unvalidated-evidence-gate";
import type { AgentViewReadStore } from "@worthline/db";
import type { ChatToolsInput } from "./input";
import type { CatalogReader } from "./reading";

/**
 * ONE chat turn's tool context: the reader bound to this turn's `asOf`, the gates
 * the route resolved, and the two pieces of mutable state a turn owns.
 *
 * It exists so a tool family module states what it needs and nothing else. Every
 * family reads the SAME gates from here — an eighth family cannot quietly grow its
 * own copy of the evidence frontier, which is the failure this seam is against.
 */
export interface ChatToolTurn {
  /** The turn's raw input, for the fields a single family reads on its own. */
  input: ChatToolsInput;
  /** YYYY-MM-DD valuation date — the demo clock for demo targets. */
  asOf: string;
  /** Reads the agent-view catalog with this turn's `asOf` bound. */
  catalogRead: CatalogReader;
  /**
   * Premium document ingestion is closed for this caller (#1162): true only for an
   * authenticated `free` workspace. A gated tool relays it honestly and manual
   * tracking stays open.
   */
  ingestionGated: boolean;
  /** The unvalidated-evidence gate bites this turn (#1248). */
  unvalidatedEvidence: boolean;
  /** The turn CARRIES unvalidated evidence, gated or not (#1257). */
  hasUnvalidatedEvidence: boolean;
  /** Public holding ids a read or the history already surfaced (#1263). */
  groundedHoldingIds: GroundedHoldingIds;
  /** What a debt-series lane may build from, or the refusal to answer with (#1418). */
  debtSeriesRows: DebtSeriesRows;
  /** Runs a single-fact proposal under this turn's unvalidated-evidence cap. */
  withProposalBudget: <T>(run: () => Promise<T>) => Promise<T | UnvalidatedEvidenceError>;
}

/** Resolves a debt-series lane's rows and the document to record them against. */
type DebtSeriesRows = <Row extends TypedBalanceRow>(
  toolName: string,
  args: { rows?: readonly Row[]; documentName?: string },
) =>
  | { rows: readonly (Row | TypedBalanceRow)[]; documentName?: string }
  | UnvalidatedEvidenceError;

export function createChatToolTurn(input: ChatToolsInput): ChatToolTurn {
  const catalogOptions = { asOf: input.asOf };
  const catalogRead = <Input, Output>(
    tool: Parameters<typeof runCatalogRead<Input, Output>>[0],
    catalogInput: Input,
    agentView: AgentViewReadStore,
  ) => runCatalogRead(tool, catalogInput, agentView, catalogOptions);

  // Premium document ingestion (#1162): false only for an authenticated free
  // workspace. The gated tools relay this honestly; manual tracking stays open.
  const ingestionGated = input.ingestionAllowed === false;

  // The unvalidated-evidence boundary (#1248): the classification and the
  // envelopes live in the pure gate module; here we only apply them. The budget
  // is this turn's single piece of mutable state — this context is built once per
  // turn, so the cap spans every tool round `streamText` may take.
  const unvalidatedEvidence = input.unvalidatedEvidence === true;
  const proposalBudget = createUnvalidatedProposalBudget();
  // The premise behind that verdict, and the only thing the provenance mark of
  // #1257 needs: unvalidated evidence is in play, gated or not. Defaults to the
  // verdict so a caller that only knows about the gate (fixtures, the evals) still
  // marks the turns it does gate.
  const hasUnvalidatedEvidence = input.hasUnvalidatedEvidence ?? unvalidatedEvidence;

  // Holding-id provenance (#1263): the turn's second piece of mutable state, for the
  // same reason as the budget. Reads ground the ids they answer, writes are refused
  // the ids nothing grounded — both applied once, over the whole set, at the end.
  const groundedHoldingIds = createGroundedHoldingIds(input.groundedHoldingIds ?? []);

  /**
   * What a debt-series lane may build from — its rows and the document to record them
   * against — or the refusal to answer with (#1418).
   *
   * The frontier decides ({@link gatedDebtSeries}); this resolves the two things that
   * belong to the CALL. The document name, because a series read off the chat is backed
   * by the message and never by the file the model may still be naming in
   * `documentName` — resolved here once rather than at each call site, so the two lanes
   * cannot drift on it. And the envelope, so a lane that could not read what the user
   * wrote says THAT instead of asking him to write it again.
   */
  const debtSeriesRows = <Row extends TypedBalanceRow>(
    toolName: string,
    args: { rows?: readonly Row[]; documentName?: string },
  ):
    | { rows: readonly (Row | TypedBalanceRow)[]; documentName?: string }
    | UnvalidatedEvidenceError => {
    const resolved = gatedDebtSeries<Row, TypedBalanceRow>({
      gated: unvalidatedEvidence,
      modelRows: args.rows ?? [],
      toolName,
      typedSeries: input.typedBalanceSeries ?? NO_TYPED_BALANCE_SERIES,
    });
    switch (resolved.source) {
      case "closed":
        return unvalidatedEvidenceRejected();
      case "unreadable_series":
        return unreadableTypedSeriesRejected();
      case "user_typed":
        return {
          documentName: TYPED_BALANCE_SERIES_DOCUMENT_NAME,
          rows: resolved.rows,
        };
      default:
        return {
          rows: resolved.rows,
          ...(args.documentName === undefined ? {} : { documentName: args.documentName }),
        };
    }
  };

  /**
   * Wrap a single-fact proposal (the whitelist): allowed on unvalidated
   * evidence, but only once per turn — repeating a puntual tool twelve times is
   * the bulk import the frontier forbids. The slot is reserved BEFORE the await
   * (the AI SDK runs a step's tool-calls concurrently) and handed back when no
   * proposal came out, so a builder error or throw costs the user nothing.
   */
  const withProposalBudget = async <T>(
    run: () => Promise<T>,
  ): Promise<T | UnvalidatedEvidenceError> => {
    if (!unvalidatedEvidence) return run();
    if (!proposalBudget.reserve()) return unvalidatedEvidenceCapReached();
    try {
      const result = await run();
      if (!consumesUnvalidatedEvidenceBudget(result)) proposalBudget.release();
      return result;
    } catch (error) {
      proposalBudget.release();
      throw error;
    }
  };

  return {
    asOf: input.asOf,
    catalogRead,
    debtSeriesRows,
    groundedHoldingIds,
    hasUnvalidatedEvidence,
    ingestionGated,
    input,
    unvalidatedEvidence,
    withProposalBudget,
  };
}
