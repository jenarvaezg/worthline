/**
 * The facts the MyInvestor ingestion adapter emits through the port of ADR 0066
 * (#1878, ADR 0115). They are the payloads of {@link NormalizedFact}s: the port never
 * reads them, the application maps each one to its dated-fact family.
 *
 * What they deliberately do NOT carry (PRD #1876, invariants 2 and 3):
 * - a price for valuing the holding: worthline prices it by ISIN or DGS code;
 * - a cost: worthline derives it as a moving average from the operations, and on a
 *   traspaso it travels from the origin (ADR 0082). MyInvestor's «invertido» is
 *   never read. The `pricePerUnit` of an operation is the NAV or price it executed
 *   at, the same figure a manual buy states.
 *
 * Amounts and units are `DecimalString`; no money passes through a `number`.
 */

import type { IsoDate, MyInvestorOwnership } from "@pricing/myinvestor/models";
import type { DecimalString, NormalizedFact, OperationKind } from "@worthline/domain";

/** Where an order lives at MyInvestor: the fund orders, the broker or a pension account. */
export type MyInvestorProduct = "fund" | "broker" | "pension_plan";

/**
 * What the order bought or sold. Funds, ETF and shares by ISIN; a pension plan by
 * its DGS code (`N####`), which is its identity: a plan has no ISIN (#1454).
 */
export type MyInvestorInstrument =
  | { readonly scheme: "isin"; readonly code: string }
  | { readonly scheme: "dgs"; readonly code: string };

/** Why a traspaso leg goes without its other half. */
export type MyInvestorUnpairedReason =
  /** The two halves share no id and nothing else ties them safely (`INTERNAL_TRANSFER_*`). */
  | "no_common_reference"
  /** No opposite leg with the same account, day and amount in the window. */
  | "no_counterpart"
  /** More than one opposite leg fits: pairing would be a guess about where the cost goes. */
  | "ambiguous";

/**
 * The traspaso side of an operation fact, or `null` on a plain buy or sell.
 *
 * - `paired`: both halves are in MyInvestor and carry the same `transferId`, so the
 *   application writes the pair through the traspaso gate and the cost travels.
 * - `external_in`: the capital came from another institution. The adapter has no
 *   origin, so the inherited cost is pending: the application asks for it (#1869 P1,
 *   #1882). Nothing is invented.
 * - `unpaired`: a traspaso leg the adapter could not tie to its other half. It still
 *   moves the units (P8 needs them) and carries its own `transferId`; on the way in
 *   its inherited cost is pending, as on an external entry. The application decides
 *   what to ask.
 */
export type MyInvestorTransferLeg =
  | {
      readonly pairing: "paired";
      readonly transferId: string;
      /** The other half's dedup key. */
      readonly counterpartKey: string;
    }
  | {
      readonly pairing: "external_in";
      readonly transferId: string;
      readonly inheritedCost: "pending";
    }
  | {
      readonly pairing: "unpaired";
      readonly reason: MyInvestorUnpairedReason;
      /** The leg's own id, so a reader finds one row of a traspaso, not a broken pair. */
      readonly transferId: string;
      /**
       * On a `transfer_in`, `pending`: its `amount` is the value that moved, never
       * the cost (#1869 P1, ADR 0082), so the cost is asked like an external entry's.
       * `null` on a `transfer_out`, whose cost is the origin's own.
       */
      readonly inheritedCost: "pending" | null;
    };

/**
 * The `transferId` a leg with no pair in MyInvestor carries, by why it has none:
 * the capital came from another institution, or the adapter could not tie it to its
 * other half. The application reads them back to word what it asks (#1882): an
 * external entry is never offered an origin inside MyInvestor.
 */
export const MYINVESTOR_EXTERNAL_TRANSFER_PREFIX = "myinvestor-external:";
export const MYINVESTOR_UNPAIRED_TRANSFER_PREFIX = "myinvestor-unpaired:";

/** Whether a `transferId` is an entry from another institution's (#1882). */
export function isMyInvestorExternalEntry(transferId: string | undefined): boolean {
  return transferId?.startsWith(MYINVESTOR_EXTERNAL_TRANSFER_PREFIX) ?? false;
}

/** Whether a `transferId` is a leg the adapter could not pair (#1882). */
export function isMyInvestorUnpairedLeg(transferId: string | undefined): boolean {
  return transferId?.startsWith(MYINVESTOR_UNPAIRED_TRANSFER_PREFIX) ?? false;
}

/** One finished order, in the vocabulary of the investment and traspaso commands. */
export interface MyInvestorOperationFact {
  readonly kind: "operation";
  /** The order's id at MyInvestor (`reference`, or the broker's `orderReference`). */
  readonly reference: string;
  readonly product: MyInvestorProduct;
  /** The securities or pension account the order belongs to. */
  readonly accountId: string;
  readonly instrument: MyInvestorInstrument;
  readonly instrumentName: string | null;
  readonly operation: OperationKind;
  /** The order day. `effectiveDate` and `expirationDate` are not a settlement date. */
  readonly executedAt: IsoDate;
  /** Always positive; `operation` says which way they move. */
  readonly units: DecimalString;
  /** The NAV or price it executed at; `null` when MyInvestor states none (an external entry). */
  readonly pricePerUnit: DecimalString | null;
  /** The cash of the order, gross of fees; `null` when MyInvestor states none. */
  readonly amount: DecimalString | null;
  /** Commissions charged on top; `"0"` for funds and plans. */
  readonly fees: DecimalString;
  readonly currency: string;
  /** MyInvestor's own operation type, as provenance (`PLAN_CONTRIBUTION`, `BUY`…). */
  readonly sourceType: string;
  readonly transfer: MyInvestorTransferLeg | null;
}

/** The units MyInvestor says a holding has today: the witness of P8 (#1869). */
export interface MyInvestorPositionFact {
  readonly kind: "position";
  readonly product: MyInvestorProduct;
  readonly accountId: string;
  readonly instrument: MyInvestorInstrument;
  readonly instrumentName: string | null;
  readonly units: DecimalString;
  readonly asOf: IsoDate;
}

/**
 * A cash account's balance today. `balance` is the available balance plus what is
 * held for orders in progress: the held part still belongs to the user until the
 * order settles, so the patrimonio does not dip for a few days (PRD #1876, invariant 4).
 */
export interface MyInvestorCashBalanceFact {
  readonly kind: "cash_balance";
  readonly accountId: string;
  readonly currency: string;
  readonly available: DecimalString;
  readonly withheld: DecimalString;
  readonly balance: DecimalString;
  readonly ownership: MyInvestorOwnership;
  readonly asOf: IsoDate;
}

export type MyInvestorFactPayload =
  | MyInvestorOperationFact
  | MyInvestorPositionFact
  | MyInvestorCashBalanceFact;

export type MyInvestorFact = NormalizedFact<MyInvestorFactPayload>;

/** Why a finished order produced no fact. Reported, never swallowed. */
export type MyInvestorSkipReason =
  | "unrecognized_type"
  | "missing_instrument"
  | "missing_date"
  | "no_units"
  /** A broker execution in another currency or at a rate that is not one. */
  | "unsupported_currency";

export interface MyInvestorSkippedOrder {
  readonly reference: string;
  readonly product: MyInvestorProduct;
  readonly sourceType: string | null;
  readonly reason: MyInvestorSkipReason;
}
