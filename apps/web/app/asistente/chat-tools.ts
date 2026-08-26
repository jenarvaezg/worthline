import { withHoldingIdProvenance } from "@web/asistente/holding-id-provenance";
import { stampProposalTools } from "@web/asistente/proposal-provenance";
import type { ToolSet } from "ai";
import type { ChatToolsInput } from "./chat-tools/input";
import { maintainerAlertTools } from "./chat-tools/maintainer-alert";
import { correctionProposalTools } from "./chat-tools/proposals/correction";
import { debtSeriesProposalTools } from "./chat-tools/proposals/debt-series";
import { earlyRepaymentProposalTools } from "./chat-tools/proposals/early-repayment";
import { holdingCreationProposalTools } from "./chat-tools/proposals/holdings";
import { housingAnchorProposalTools } from "./chat-tools/proposals/housing-anchors";
import { mixedDocumentProposalTools } from "./chat-tools/proposals/mixed-document";
import { operationProposalTools } from "./chat-tools/proposals/operation";
import { reconcileProposalTools } from "./chat-tools/proposals/reconcile";
import { statementProposalTools } from "./chat-tools/proposals/statement";
import { transferProposalTools } from "./chat-tools/proposals/transfer";
import { trashProposalTools } from "./chat-tools/proposals/trash";
import { actionReadTools } from "./chat-tools/reads/actions";
import { contextReadTools } from "./chat-tools/reads/context";
import { dataQualityReadTools } from "./chat-tools/reads/data-quality";
import { documentReadTools } from "./chat-tools/reads/documents";
import { fireReadTools } from "./chat-tools/reads/fire";
import { historyReadTools } from "./chat-tools/reads/history";
import { holdingReadTools } from "./chat-tools/reads/holdings";
import { marketSymbolReadTools } from "./chat-tools/reads/market-symbol";
import { sourceReadTools } from "./chat-tools/reads/sources";
import { createChatToolTurn } from "./chat-tools/turn";

/**
 * The assistant's chat tool REGISTRY (#629/#630, ADR 0047). Each family declares
 * its own tools in its own module under `chat-tools/`; this file only says which
 * families exist and what wraps the whole set.
 *
 * This is intentionally a separate chat catalog, not the MCP transport: tool names
 * stay in parity where the assistant needs the same lens, while chat-specific
 * payload trimming and money formatting stay local to this boundary (`reading.ts`).
 * Calculation logic stays in agent-view; the model never defines its own net-worth
 * formula, only summarizes/compares what these reads return.
 *
 * Live financial-fact writes are impossible by construction: tools receive the read
 * store plus the narrow durable assistant-proposal store (`stores.ts`). The latter
 * persists only typed draft facts and document references; applying them still
 * requires the separate explicit-confirmation server action.
 *
 * Adding a proposal is a module under `proposals/` plus one line below. Adding a
 * FIELD to the turn is `input.ts` plus `turn.ts` — deliberately the one edit that
 * every family sees, because the evidence and paywall frontiers must not fork.
 *
 * The ORDER below is the one thing the split changed on purpose. The old order was
 * append-only history — `search_market_symbol` sat between two proposals because
 * that is where it was written — and the model sees the tool list in it. It is now
 * the family map: every read, then every proposal, then the alert. Names, schemas
 * and refusals are byte-identical (ADR 0086).
 *
 * Exposure look-through and investment returns are agent-view facts exposed through
 * the relevant context/detail tools; add dedicated chat wrappers only when the
 * conversation needs a new public tool shape.
 *
 * What a description may say, decided in #1342: only what is true of THIS tool —
 * its argument units, its enum semantics, what the app computes or rejects for it.
 * A rule that spans tools goes in the system prompt instead, where it is written
 * once rather than once per tool, and a rule that is an invariant goes in code
 * (ADR 0067). The measurement behind the rule, and the table of what moved where,
 * are in `eval/README.md`.
 */

export type { ChatToolsInput } from "./chat-tools/input";
export { type ChatReadStore, chatToolStores } from "./chat-tools/stores";

export function createChatTools(input: ChatToolsInput): ToolSet {
  const turn = createChatToolTurn(input);

  const tools: ToolSet = {
    ...contextReadTools(turn),
    ...fireReadTools(turn),
    ...historyReadTools(turn),
    ...dataQualityReadTools(turn),
    ...holdingReadTools(turn),
    ...sourceReadTools(turn),
    ...marketSymbolReadTools(),
    ...actionReadTools(turn),
    ...documentReadTools(turn),
    ...statementProposalTools(turn),
    ...mixedDocumentProposalTools(turn),
    ...reconcileProposalTools(turn),
    ...housingAnchorProposalTools(turn),
    ...debtSeriesProposalTools(turn),
    ...earlyRepaymentProposalTools(turn),
    ...correctionProposalTools(turn),
    ...holdingCreationProposalTools(turn),
    ...trashProposalTools(turn),
    ...operationProposalTools(turn),
    ...transferProposalTools(turn),
    ...maintainerAlertTools(turn),
  };

  const grounded = withHoldingIdProvenance(
    tools,
    turn.groundedHoldingIds,
    input.onUngroundedHoldingId,
  );
  // The provenance mark (#1257): stamped over the whole tool set when the turn
  // CARRIES unvalidated evidence, which is a different question from whether the
  // gate above bites — a turn that also brought a validated document is not gated,
  // and the unreadable file is still in the model's context. The card says where the
  // proposal comes from; the gate decides what may be written. Tying the mark to the
  // gate's verdict would drop it on exactly the most confusable turn.
  return turn.hasUnvalidatedEvidence ? stampProposalTools(grounded) : grounded;
}
