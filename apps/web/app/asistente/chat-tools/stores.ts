import type {
  AgentViewReadStore,
  AssistantProposalStore,
  WorthlineStore,
} from "@worthline/db";

/**
 * The stores one chat tool call may reach (#629/#630, ADR 0047).
 *
 * Live financial-fact writes are impossible by construction: tools receive the
 * read store (`agentView`) plus the narrow durable assistant-proposal store. The
 * latter persists only typed draft facts and document references; applying them
 * still requires the separate explicit-confirmation server action.
 */
export interface ChatReadStore {
  agentView: AgentViewReadStore;
  assistantProposals?: AssistantProposalStore;
  liabilities?: WorthlineStore["liabilities"];
  assets?: WorthlineStore["assets"];
  /**
   * Present for the identity fill (#1349): the #1329 guard reads the ledger to
   * refuse a symbol that would reprice a «por valor total» alta as one share.
   */
  operations?: WorthlineStore["operations"];
  /** Present for the alta builder (#1105): resolves ownership at build time. */
  workspace?: WorthlineStore["workspace"];
  /** Present for the reconcile builder (#1108): fences off sync-owned holdings. */
  connectedSources?: WorthlineStore["connectedSources"];
}

/**
 * The slice of a workspace store the chat tools need, in ONE place.
 *
 * Both callers — the chat route and the admission harness (#1265) — used to list
 * the fields by hand, and the harness listed three of the six: every proposal tool
 * answered `proposal_persistence_unavailable`, so the write path could not be
 * measured at all. An eighth field would have re-armed exactly that.
 */
export function chatToolStores(store: WorthlineStore): ChatReadStore {
  return {
    agentView: store.agentView,
    assets: store.assets,
    assistantProposals: store.assistantProposals,
    connectedSources: store.connectedSources,
    liabilities: store.liabilities,
    operations: store.operations,
    workspace: store.workspace,
  };
}
