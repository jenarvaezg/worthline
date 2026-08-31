import type { OperationKind } from "@worthline/domain";

import type { AgentViewMoney, AgentViewPaginationMeta } from "./shared";

export type AgentViewOperationSort = "date" | "-date";

/**
 * One investment operation row (PRD #328, #337). Units and price are decimal
 * strings; `grossAmount` is units × price as money (raw ledger amount, not
 * scope-weighted). `id` is derived from the stable internal operation id.
 */
export interface AgentViewOperation {
  id: string;
  object: "operation";
  /** Execution date, as `YYYY-MM-DD`. */
  date: string;
  /**
   * Four kinds, not two (#1393): the halves of a traspaso are reported as what they
   * are. A reader that saw `sell` on the outgoing half would count a realized gain
   * the ledger deliberately does not have.
   */
  kind: OperationKind;
  units: string;
  pricePerUnit: string;
  grossAmount: AgentViewMoney;
  fees: AgentViewMoney;
  /**
   * The id of the traspaso this operation belongs to, present on the traspaso kinds
   * and on nothing else — what lets a reader pair an outgoing leg with the incoming
   * one.
   *
   * An id that appears on ONE `transfer_in` and nowhere else is not a broken pair: it
   * is an **entrada por traspaso externo** (#1541), a position brought in from another
   * institution whose outgoing half lives in that institution's ledger and can never
   * be written here. Read it as capital that arrived, never as a purchase — it made no
   * contribution and realized no gain, and its `transferCostMinor` is the cost the
   * participaciones carried over.
   */
  transferId?: string;
}

/** Cursor-paginated operations for an investment holding (PRD #328, #337). */
export interface AgentViewOperationPage {
  operations: AgentViewOperation[];
  meta: AgentViewPaginationMeta;
}
