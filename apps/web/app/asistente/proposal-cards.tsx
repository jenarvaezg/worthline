"use client";

import type { UIMessage } from "ai";
import { proposalCardInPart } from "./proposal-card-presence";
import { BalanceHistoryProposalCard } from "./proposal-cards/balance-history";
import { CorrectionProposalCard } from "./proposal-cards/correction";
import { EarlyRepaymentProposalCard } from "./proposal-cards/early-repayment";
import type { ProposalCardGate } from "./proposal-cards/gate";
import { HoldingCreationProposalCard } from "./proposal-cards/holding-creation";
import { HoldingTrashProposalCard } from "./proposal-cards/holding-trash";
import { MixedDocumentProposalCard } from "./proposal-cards/mixed-document";
import { OperationProposalCard } from "./proposal-cards/operation";
import { PropertyAcquisitionProposalCard } from "./proposal-cards/property-acquisition";
import { PropertyValuationProposalCard } from "./proposal-cards/property-valuation";
import { ReconcileProposalCard } from "./proposal-cards/reconcile";
import { ReconstructionProposalCard } from "./proposal-cards/reconstruction";
import { StatementProposalCard } from "./proposal-cards/statement";
import { TransferProposalCard } from "./proposal-cards/transfer";

/**
 * The assistant's proposal card REGISTRY (#1589, ADR 0088). Each kind of proposal
 * paints itself in its own module under `proposal-cards/`; this file only says which
 * card paints which kind.
 *
 * The layer around it is the shell — composer, conversation, transport — and it holds
 * none of this markup. Adding a proposal is a module under `proposal-cards/` plus one
 * `case` below; adding a card used to be an edit to the file every card already edited,
 * which is how twelve cards and 2.577 lines ended up in one place.
 *
 * What a card is entitled to is `ProposalCardGate` (`proposal-cards/gate.ts`) and its
 * own parsed proposal. It never sees the conversation, the transport or the panel's
 * state, so a card cannot grow a second opinion about the turn it was born in. The
 * valuation card is the one that takes LESS: it has never had a message to print for
 * the demo gate, and giving it one here would put a sentence on screen that no card
 * prints today.
 */

/**
 * The proposal card a tool answer unfolds into, or `null` when the answer is not a
 * proposal (every read tool runs silently) or does not parse as one.
 *
 * The parsing is NOT here, and neither is the census of kinds: both come from
 * `proposal-card-presence`, the table the fabricated-ceremony guard reads too (#1468),
 * and the switch below is exhaustive over its union — a new kind fails the typecheck
 * until it has a card. Before that, this function held the
 * only copy of «did this answer become a card», and the guard asked a different
 * question — whether a `propose_*` tool had been called — so a rejected call silenced
 * the warning exactly like a real card. What is left here is the half that is genuinely
 * about rendering: which component paints which proposal.
 *
 * A plain function and not a component because the caller has to KNOW there is a
 * card before deciding what to wrap it in: the provenance mark of #1257 opens a
 * paper entry, and an entry with a stamp and no card would be the app pointing at
 * nothing.
 */
export function proposalCardFor({
  mutationsDisabled,
  mutationsDisabledMessage,
  part,
}: ProposalCardGate & { part: UIMessage["parts"][number] }): React.ReactNode | null {
  const card = proposalCardInPart(part);
  if (card === null) return null;
  const gate = { mutationsDisabled, mutationsDisabledMessage };
  switch (card.kind) {
    case "balance_history":
      return <BalanceHistoryProposalCard {...gate} proposal={card.proposal} />;
    case "correction":
      // Una enmienda (#1423) devuelve la MISMA propuesta de corrección, con la serie
      // enmendada: su tarjeta es la de siempre, o no habría tarjeta.
      return card.proposal.mode === "reconstruir" ? (
        <ReconstructionProposalCard {...gate} proposal={card.proposal} />
      ) : (
        <CorrectionProposalCard {...gate} proposal={card.proposal} />
      );
    case "early_repayment":
      return <EarlyRepaymentProposalCard {...gate} proposal={card.proposal} />;
    case "holding_creation":
      return <HoldingCreationProposalCard {...gate} proposal={card.proposal} />;
    case "holding_trash":
      return <HoldingTrashProposalCard {...gate} proposal={card.proposal} />;
    case "mixed_document":
      return <MixedDocumentProposalCard {...gate} proposal={card.proposal} />;
    case "operation":
      return <OperationProposalCard {...gate} proposal={card.proposal} />;
    case "property_acquisition":
      return <PropertyAcquisitionProposalCard {...gate} proposal={card.proposal} />;
    case "property_valuation":
      return (
        <PropertyValuationProposalCard
          mutationsDisabled={mutationsDisabled}
          proposal={card.proposal}
        />
      );
    case "reconcile":
      return <ReconcileProposalCard {...gate} proposal={card.proposal} />;
    case "statement_import":
      return <StatementProposalCard {...gate} proposal={card.proposal} />;
    case "transfer":
      return <TransferProposalCard {...gate} proposal={card.proposal} />;
  }
}
