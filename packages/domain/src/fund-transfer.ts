import {
  compareUnits,
  type DecimalString,
  divideUnits,
  minorToDecimal,
  multiplyToMinor,
  proportionMinor,
  UNITS_READBACK_DECIMALS,
} from "./decimal";
import type { DomainResult, DomainViolation } from "./domain-result";
import type { CreateInvestmentOperationInput, OperationSource } from "./investment-types";
import type { CurrencyCode } from "./money";
import { assertMinorInteger } from "./money";

/**
 * The traspaso plan (#1479, PRD #1393): the arithmetic and the refusals of a
 * fund-to-fund transfer, resolved into the exact PAIR of operations the write gate
 * will persist — and nothing else.
 *
 * Why it is a module of its own, pure, upstream of the gate. Three separate
 * derivations have to agree to the cent: the units leaving the origin, the units
 * entering the destination, and the acquisition cost that travels between them. The
 * gate owns a transaction and a ripple; this owns the numbers. Splitting them is
 * what lets every hostile case — a VL of zero, an amount larger than the position,
 * a holding traspasado to itself — be a table-driven test instead of a database
 * fixture, and it is what will let the screen of #1480 PREVIEW the same pair it is
 * about to write, from the same code, without a round trip.
 *
 * What a caller must supply, because this module cannot know it: the state of the
 * origin's ledger on the transfer date ({@link FundTransferOrigin}), folded by
 * `derivePosition` from that holding's own operations.
 */

/**
 * The origin's position on the transfer date, folded from its ledger up to and
 * including that day.
 *
 * Both figures come from ONE `derivePosition` call, never from two reads: the
 * inherited cost is a proportion of the cost basis over the units, so a pair taken
 * from different folds would slice a cost that never belonged to those units.
 */
export interface FundTransferOrigin {
  /** Participaciones held on the date, before this traspaso. */
  unitsHeld: DecimalString;
  /** Acquisition cost of those units, integer minor units. */
  costBasisMinor: number;
}

/**
 * How much of the origin leaves. «Todo» is NOT the amount that happens to equal the
 * whole position: it is its own intent, because only it can liquidate the origin
 * exactly (see {@link planFundTransfer}).
 */
export type FundTransferPortion =
  | { kind: "amount"; amountMinor: number }
  | { kind: "all" };

/** Everything the user (or the assistant) states about one traspaso. */
export interface FundTransferIntent {
  /**
   * The id that will tie the two halves. Supplied, never minted here: a replayed
   * submit must land on the SAME pair rather than a second one, so the id is a
   * function of the submission (#1394) and that is the caller's to derive — the same
   * reason `createInvestmentOperation` takes its id.
   */
  transferId: string;
  outOperationId: string;
  inOperationId: string;
  originAssetId: string;
  destinationAssetId: string;
  /** YYYY-MM-DD — the ONE date both halves carry. */
  executedAt: string;
  portion: FundTransferPortion;
  /** The origin's VL on {@link FundTransferIntent.executedAt}. */
  originPricePerUnit: DecimalString;
  /** The destination's VL on the same date. */
  destinationPricePerUnit: DecimalString;
  currency: CurrencyCode;
  /**
   * The transfer commission, integer minor units. It rides the INCOMING half,
   * capitalized into the destination's cost exactly as on a buy (ADR 0082) — the
   * outgoing half realizes no P/L to charge it against, and a `transfer_out`
   * carrying fees is refused by the row constructor.
   */
  feesMinor?: number;
  source?: OperationSource;
  /** Source instant, when the writer has one. Rides both halves identically. */
  occurredAt?: string;
}

/** The pair, plus the two derived figures a preview or a card wants to print. */
export interface FundTransferPair {
  out: CreateInvestmentOperationInput;
  /**
   * The incoming half. Named `incoming` rather than `in` so the field never reads
   * as the keyword at a call site (`pair.in`).
   */
  incoming: CreateInvestmentOperationInput;
  /**
   * The euro amount that moved. Echoes the stated one for an `amount` portion, and
   * is DERIVED at the origin's VL for «todo» — which is the figure the bank's
   * confirmation will show.
   */
  amountMinor: number;
  /** The acquisition cost that travelled, integer minor units. */
  inheritedCostMinor: number;
}

/** The violations this module can report, narrowed from the shared vocabulary. */
type FundTransferViolation = Extract<
  DomainViolation,
  {
    code:
      | "operation_fees_negative"
      | "transfer_amount_not_positive"
      | "transfer_origin_has_no_units"
      | "transfer_price_not_positive"
      | "transfer_same_holding"
      | "transfer_units_exceed_position";
  }
>;

/** A refusal, shaped so it satisfies both this module's result types. */
function refuse(violation: FundTransferViolation): {
  ok: false;
  violations: [FundTransferViolation];
} {
  return { ok: false, violations: [violation] };
}

/** The units leaving the origin and the euro amount they stand for, or a refusal. */
type PortionResolution =
  | { ok: true; amountMinor: number; outUnits: DecimalString }
  | { ok: false; violations: [FundTransferViolation] };

/**
 * Resolve one traspaso into the pair of operations that records it, or the ONE
 * violation that refuses it.
 *
 * The arithmetic, and why each step is what it is:
 *
 * - **The importe rules, not the participaciones.** The bank states «traspaso
 *   1.018,67 €»; each half's units are that amount over ITS OWN VL on the date. The
 *   two unit counts are unrelated figures — that is the whole point of the
 *   instrument — and neither is ever typed by the user.
 * - **Cut at the precision the app can read back** ({@link UNITS_READBACK_DECIMALS},
 *   #1395). A raw division leaves twenty decimals that no bank publishes and that
 *   `formatUnits` cannot show, so the ficha would print a figure the ledger does not
 *   hold.
 * - **«Todo» takes the position itself, not a division.** Cutting `importe ÷ VL` at
 *   six decimals leaves up to a millionth of a unit behind, and a fund the user
 *   emptied has to read as empty — a residual position is a phantom holding in every
 *   list, warning and donut. Its euro amount is then derived from those exact units.
 * - **The inherited cost is the same proportion the fold removes** (`proportionMinor`
 *   over the running weighted average, ADR 0040/0082). Computed here, once, and
 *   persisted on the incoming row: `derivePosition` folds ONE asset's ledger and
 *   must never cross over to the origin to learn it.
 * - **An amount over the position is refused, not clamped.** The fold clamps an
 *   over-sell because it is reading a ledger it did not write; a gate is the last
 *   place that can still say no, and a traspaso the bank never executed must not
 *   enter the book at all. The violation carries both unit counts so the message can
 *   name them and offer «todo».
 *
 * Programmer errors still throw: two halves sharing one operation id would collide
 * on the primary key and leave the pair half-written, which is the single failure
 * mode this gate exists to prevent — no form can produce it, so it is a bug, not
 * data.
 */
export function planFundTransfer(
  intent: FundTransferIntent,
  origin: FundTransferOrigin,
): DomainResult<FundTransferPair> {
  if (intent.outOperationId === intent.inOperationId) {
    throw new Error("The two halves of a traspaso need distinct operation ids.");
  }

  if (intent.originAssetId === intent.destinationAssetId) {
    return refuse({ code: "transfer_same_holding" });
  }

  if (compareUnits(intent.originPricePerUnit, "0") <= 0) {
    return refuse({ code: "transfer_price_not_positive", side: "origin" });
  }

  if (compareUnits(intent.destinationPricePerUnit, "0") <= 0) {
    return refuse({ code: "transfer_price_not_positive", side: "destination" });
  }

  const feesMinor = intent.feesMinor ?? 0;
  assertMinorInteger(feesMinor);
  if (feesMinor < 0) {
    return refuse({ code: "operation_fees_negative" });
  }

  const resolved = resolvePortion(intent, origin);
  if (!resolved.ok) return resolved;
  const { amountMinor, outUnits } = resolved;

  const inUnits = divideUnits(
    minorToDecimal(amountMinor),
    intent.destinationPricePerUnit,
    UNITS_READBACK_DECIMALS,
  );

  // The destination receives the units the amount buys at its VL; a commission does
  // not shrink them, it is capitalized on top — exactly the shape of a buy, where
  // `units × price + fees` is the cost.
  if (compareUnits(inUnits, "0") <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  const inheritedCostMinor = proportionMinor(
    origin.costBasisMinor,
    outUnits,
    origin.unitsHeld,
  );

  const shared = {
    currency: intent.currency,
    executedAt: intent.executedAt,
    transferId: intent.transferId,
    ...(intent.occurredAt === undefined ? {} : { occurredAt: intent.occurredAt }),
    ...(intent.source === undefined ? {} : { source: intent.source }),
  };

  return {
    ok: true,
    value: {
      amountMinor,
      incoming: {
        ...shared,
        assetId: intent.destinationAssetId,
        feesMinor,
        id: intent.inOperationId,
        kind: "transfer_in",
        pricePerUnit: intent.destinationPricePerUnit,
        transferCostMinor: inheritedCostMinor,
        units: inUnits,
      },
      inheritedCostMinor,
      out: {
        ...shared,
        assetId: intent.originAssetId,
        feesMinor: 0,
        id: intent.outOperationId,
        kind: "transfer_out",
        pricePerUnit: intent.originPricePerUnit,
        units: outUnits,
      },
    },
  };
}

function resolvePortion(
  intent: FundTransferIntent,
  origin: FundTransferOrigin,
): PortionResolution {
  if (intent.portion.kind === "all") {
    if (compareUnits(origin.unitsHeld, "0") <= 0) {
      return refuse({ code: "transfer_origin_has_no_units" });
    }
    return {
      amountMinor: multiplyToMinor(origin.unitsHeld, intent.originPricePerUnit),
      ok: true,
      outUnits: origin.unitsHeld,
    };
  }

  const { amountMinor } = intent.portion;
  assertMinorInteger(amountMinor);
  if (amountMinor <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  const outUnits = divideUnits(
    minorToDecimal(amountMinor),
    intent.originPricePerUnit,
    UNITS_READBACK_DECIMALS,
  );

  if (compareUnits(outUnits, origin.unitsHeld) > 0) {
    return refuse({
      code: "transfer_units_exceed_position",
      unitsHeld: origin.unitsHeld,
      unitsRequested: outUnits,
    });
  }

  return { amountMinor, ok: true, outUnits };
}
