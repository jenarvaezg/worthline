import type { TransferPortion } from "@worthline/domain";

/**
 * Investment-transfer plan (#1482, S5 of PRD #1393) — the payload of an
 * `investment_transfer` assistant proposal: ONE traspaso between two investment
 * holdings that ALREADY exist.
 *
 * Why it is not an `investment_operation` twice over. A traspaso is one movement with
 * two halves (S1, #1478): the pair shares a date and a `transferId`, the acquisition
 * cost travels from origin to destination, and no P/L is realized. Two operation plans
 * could not promise any of that — the first could land and the second fail, leaving
 * capital that left the book and never arrived — so the fact persisted here is the
 * INTENT, and the pair itself is minted by the atomic gate at confirm time
 * (`recordTransferAndRipple`), exactly the gate the screen of #1480 submits to.
 *
 * What it therefore does NOT carry, deliberately: the DERIVED figures — the unit count
 * of a leg stated as an importe, and the inherited cost. Their authority is
 * `planTransfer`, run again at confirm against the ledger as it is THEN. Freezing
 * derived participaciones in the draft would let a card promise figures a later
 * operation on the origin has already changed (#1438's lesson: one engine, not two).
 * The card prints them for the user to read; the plan keeps only what was STATED —
 * which, since #1544, can be the participaciones themselves, and then it is the VL that
 * is derived and absent from here.
 */
export interface InvestmentTransferPlan {
  /** The origin's public holding id (`wl_hld_…`) the card echoes. */
  originHolding: string;
  /** The destination's public holding id. */
  destinationHolding: string;
  /** Internal asset id the participaciones leave. */
  originAssetId: string;
  /** Internal asset id they arrive at. */
  destinationAssetId: string;
  /** YYYY-MM-DD — the ONE date both halves carry. */
  executedAt: string;
  /**
   * How much of the origin left: an importe in integer minor units as the user wrote
   * it, the participaciones the confirmation printed with that importe (#1544), or
   * «todo». «Todo» is kept as its own intent rather than resolved to the importe it
   * happened to equal, because only it liquidates the origin exactly.
   */
  portion: TransferPortion;
  /**
   * The origin's VL used to derive the participaciones that left, decimal string.
   * Absent when the portion DECLARES them: then the VL is the derived figure, and
   * freezing a copy of it here would be a second answer to the same question (#1544).
   */
  originPricePerUnit?: string | undefined;
  /** The destination's VL on the same date, decimal string. Absent when the participaciones that arrived are declared. */
  destinationPricePerUnit?: string | undefined;
  /** The participaciones that ARRIVED, when they were stated rather than divided (#1544). */
  destinationUnits?: string | undefined;
  /** The currency both ledgers keep, checked equal before the draft was armed. */
  currency: string;
}
