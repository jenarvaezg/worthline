/**
 * «¿Se pintó una tarjeta?» — the one question, answered in one place (#1468).
 *
 * The fabricated-ceremony guard (#1262) used to ask something else: whether the turn
 * carried a `propose_*` tool part, by NAME. So a call worthline had rejected —
 * `{ error: "operation_document_required" }` — switched the warning off exactly like a
 * real card would, and the note vanished in the worst case there is: the model tried,
 * the app said no, and the prose announced success anyway («He preparado las
 * propuestas… A continuación tienes las tarjetas para confirmar»). Nothing was painted
 * and nothing warned.
 *
 * The app already knew the right answer two files away: the render only paints when
 * `parse*Proposal(output)` recognises a proposal. What was missing was that the guard
 * and the render read the SAME table — the render getting its parsed proposal from
 * here, the guard getting its boolean — so they cannot drift apart in silence the day
 * a lane is widened, which is the lesson the sibling seam already learnt (#1254).
 *
 * A lane is registered by tool name, and a guardian test walks `createChatTools` to
 * fail CI when a new `propose_*` is missing from the table: an unregistered lane would
 * otherwise count as «has a card» in the guard while painting nothing.
 */

import { isToolUIPart, type UIMessage } from "ai";

import type { BalanceHistoryProposal } from "./balance-history-proposal-contract";
import type { CorrectionProposal } from "./correction-proposal-contract";
import type { EarlyRepaymentProposal } from "./early-repayment-proposal-contract";
import type { HoldingCreationProposal } from "./holding-creation-proposal-contract";
import type { HoldingTrashProposal } from "./holding-trash-proposal-contract";
import type { MixedDocumentProposal } from "./mixed-document-proposals";
import type { OperationProposal } from "./operation-proposal-contract";
import type { PropertyAcquisitionProposal } from "./property-acquisition-proposal-contract";
import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";
import { parseBalanceHistoryProposal } from "./proposal-parsers/balance-history";
import { parseCorrectionProposal } from "./proposal-parsers/correction";
import { parseEarlyRepaymentProposal } from "./proposal-parsers/early-repayment";
import { parseHoldingCreationProposal } from "./proposal-parsers/holding-creation";
import { parseHoldingTrashProposal } from "./proposal-parsers/holding-trash";
import { parseMixedDocumentProposal } from "./proposal-parsers/mixed-document";
import { parseOperationProposal } from "./proposal-parsers/operation";
import { parsePropertyAcquisitionProposal } from "./proposal-parsers/property-acquisition";
import { parsePropertyValuationProposal } from "./proposal-parsers/property-valuation";
import { parseReconcileProposal } from "./proposal-parsers/reconcile";
import { parseStatementImportProposal } from "./proposal-parsers/statement-import";
import { parseTransferProposal } from "./proposal-parsers/transfer";
import type { ReconcileProposal } from "./reconcile-proposal-contract";
import type { StatementImportProposal } from "./statement-import-proposals";
import { toolPartName } from "./tool-parts";
import type { TransferProposal } from "./transfer-proposal-contract";

type Part = UIMessage["parts"][number];

/**
 * A proposal a tool answer really unfolds into, tagged by the card that paints it.
 *
 * `correction` covers the three lanes that share the correction contract — including
 * an amendment (#1423), which returns the SAME proposal with the series amended — and
 * the card that paints it is chosen from the proposal's own `mode`. `holding_trash`
 * covers removal and restoration, which the parser tells apart by `proposalType`.
 */
export type ProposalCard =
  | { kind: "balance_history"; proposal: BalanceHistoryProposal }
  | { kind: "correction"; proposal: CorrectionProposal }
  | { kind: "early_repayment"; proposal: EarlyRepaymentProposal }
  | { kind: "holding_creation"; proposal: HoldingCreationProposal }
  | { kind: "holding_trash"; proposal: HoldingTrashProposal }
  | { kind: "mixed_document"; proposal: MixedDocumentProposal }
  | { kind: "operation"; proposal: OperationProposal }
  | { kind: "property_acquisition"; proposal: PropertyAcquisitionProposal }
  | { kind: "property_valuation"; proposal: PropertyValuationProposal }
  | { kind: "reconcile"; proposal: ReconcileProposal }
  | { kind: "statement_import"; proposal: StatementImportProposal }
  | { kind: "transfer"; proposal: TransferProposal };

/** Tags a parsed proposal, and keeps `null` meaning «no card» all the way up. */
function card<K extends ProposalCard["kind"]>(
  kind: K,
  proposal: Extract<ProposalCard, { kind: K }>["proposal"] | null,
): ProposalCard | null {
  return proposal === null ? null : ({ kind, proposal } as ProposalCard);
}

/**
 * Every proposal lane, and how its output becomes a card. The guardian test derives
 * its list from `createChatTools`, so this table is the place a new lane is admitted.
 */
export const PROPOSAL_CARD_PARSERS: Record<
  string,
  ((output: unknown) => ProposalCard | null) | undefined
> = {
  propose_balance_history_import: (output: unknown) =>
    card("balance_history", parseBalanceHistoryProposal(output)),
  propose_correction: (output: unknown) =>
    card("correction", parseCorrectionProposal(output)),
  propose_early_repayment: (output: unknown) =>
    card("early_repayment", parseEarlyRepaymentProposal(output)),
  propose_holding: (output: unknown) =>
    card("holding_creation", parseHoldingCreationProposal(output)),
  propose_holding_removal: (output: unknown) =>
    card("holding_trash", parseHoldingTrashProposal(output, "holding_removal")),
  propose_holding_restoration: (output: unknown) =>
    card("holding_trash", parseHoldingTrashProposal(output, "holding_restoration")),
  propose_mixed_document_import: (output: unknown) =>
    card("mixed_document", parseMixedDocumentProposal(output)),
  propose_operation: (output: unknown) =>
    card("operation", parseOperationProposal(output)),
  propose_property_acquisition: (output: unknown) =>
    card("property_acquisition", parsePropertyAcquisitionProposal(output)),
  propose_property_valuation_anchor: (output: unknown) =>
    card("property_valuation", parsePropertyValuationProposal(output)),
  propose_reconcile: (output: unknown) =>
    card("reconcile", parseReconcileProposal(output)),
  propose_reconstruction: (output: unknown) =>
    card("correction", parseCorrectionProposal(output)),
  propose_reconstruction_amendment: (output: unknown) =>
    card("correction", parseCorrectionProposal(output)),
  propose_statement_import: (output: unknown) =>
    card("statement_import", parseStatementImportProposal(output)),
  propose_transfer: (output: unknown) => card("transfer", parseTransferProposal(output)),
};

/**
 * The card a tool's answer unfolds into, or `null` when that answer paints nothing:
 * a read tool, a lane that is not in the table, or an output its own parser rejects.
 *
 * Takes a bare name and an output, not a part, because the eval harness grades the
 * same question over a `generateText` trace (#1468, point 5) — the number the gate
 * reports and the guard that ships must not disagree about what a card is.
 */
export function proposalCardFrom(name: string, output: unknown): ProposalCard | null {
  const parse = PROPOSAL_CARD_PARSERS[name];
  return parse === undefined ? null : parse(output);
}

/**
 * {@link proposalCardFrom} for a message part.
 *
 * Three ways a `propose_*` part paints nothing, all of them «no card»: the tool
 * answered with something its parser does not recognise (a rejection, most often),
 * the tool call itself failed (`output-error`, `output-denied`), or the call never
 * got an output because the stream died mid-flight.
 */
export function proposalCardInPart(part: Part): ProposalCard | null {
  if (!isToolUIPart(part)) return null;
  const { state } = part as { state?: string };
  if (state === "output-error" || state === "output-denied") return null;
  if (!("output" in part)) return null;
  return proposalCardFrom(toolPartName(part), (part as { output: unknown }).output);
}

/** Did this part put a proposal card on the screen? */
export function rendersProposalCard(part: Part): boolean {
  return proposalCardInPart(part) !== null;
}
