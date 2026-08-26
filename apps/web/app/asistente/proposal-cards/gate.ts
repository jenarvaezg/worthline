/**
 * What every proposal card needs from the layer around it, and nothing more: whether
 * writes are shut (demo mode) and the sentence to print when they are.
 *
 * A card is handed this and its own parsed proposal. It never sees the conversation,
 * the transport or the panel's state — which is what makes a new card a new module
 * rather than an edit to the shell (ADR 0088).
 */
export type ProposalCardGate = {
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
};
