import {
  compareUnits,
  type DecimalString,
  divideUnits,
  minorToDecimal,
  multiplyToMinor,
  PRICE_READBACK_DECIMALS,
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
 * origin's ledger on the transfer date ({@link TransferOrigin}), folded by
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
export interface TransferOrigin {
  /** Participaciones held on the date, before this traspaso. */
  unitsHeld: DecimalString;
  /** Acquisition cost of those units, integer minor units. */
  costBasisMinor: number;
}

/**
 * How much of the origin leaves, in the three ways a real confirmation states it.
 *
 * - **`amount`** — the importe, the way an ORDER is given («traspásame 739,22 €»).
 *   The participaciones are then divided out of it at the origin's VL.
 * - **`all`** — «todo». NOT the amount that happens to equal the whole position: it
 *   is its own intent, because only it can liquidate the origin exactly (see
 *   {@link planTransfer}). Its `amountMinor` is the importe the confirmation printed
 *   for the whole position, when there is one; without it, the amount is derived at
 *   the origin's VL.
 * - **`units`** — the participaciones the confirmation prints, together with its
 *   importe (#1544). This is the reading that matches the rest of the book: on a buy
 *   or a sell the participaciones are the declared fact and the price is derived
 *   (`InvestmentOperationPlan.pricePerUnit`), and the traspaso was the one door that
 *   inverted it. Here the VL is derived, so a VL nobody typed — or typed with fewer
 *   decimals than the bank publishes — can no longer put participaciones in the book
 *   that are not the bank's.
 */
export type TransferPortion =
  | { kind: "amount"; amountMinor: number }
  | { kind: "all"; amountMinor?: number | undefined }
  | { kind: "units"; units: DecimalString; amountMinor: number };

/** Everything the user (or the assistant) states about one traspaso. */
export interface TransferIntent {
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
  portion: TransferPortion;
  /**
   * The origin's VL on {@link TransferIntent.executedAt}.
   *
   * Optional, because a leg that DECLARES its participaciones derives it (#1544):
   * absent is the ordinary case when the user is copying a justificante. It is
   * required — and refused as missing — only where nothing else can produce it: an
   * `amount` portion, or an `all` portion with no importe stated.
   */
  originPricePerUnit?: DecimalString | undefined;
  /**
   * The participaciones that ARRIVED, when the confirmation prints them (#1544).
   * Stated, they are what the destination's row holds and its VL is derived from
   * them; absent, they are divided out of the arriving importe at
   * {@link TransferIntent.destinationPricePerUnit}.
   */
  destinationUnits?: DecimalString | undefined;
  /** The destination's VL on the same date — optional for the same reason as the origin's. */
  destinationPricePerUnit?: DecimalString | undefined;
  /**
   * The amount that ARRIVED, when the bank states a different one from what left.
   * Absent means "the same", which is the ordinary case and the only one a form needs
   * to ask about.
   *
   * The two halves of a real traspaso genuinely do NOT match: the origin is valued the
   * day the capital leaves and the destination the day it lands, days apart. Measured
   * in Jorge's book on the 19-ago pass — 739,22 € out, 740,72 € in — with the explicit
   * conclusion that «ninguna validación debería exigir igualdad de importes». Forcing
   * one figure onto both halves would put 1,50 € of participaciones nobody bought into
   * the destination. What ties the halves is the `transferId`, never the amount.
   */
  destinationAmountMinor?: number;
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
export interface TransferPair {
  out: CreateInvestmentOperationInput;
  /**
   * The incoming half. Named `incoming` rather than `in` so the field never reads
   * as the keyword at a call site (`pair.in`).
   */
  incoming: CreateInvestmentOperationInput;
  /**
   * The euro amount that LEFT. Echoes the stated one for an `amount` portion, and is
   * DERIVED at the origin's VL for «todo» — which is the figure the bank's
   * confirmation will show.
   */
  outgoingAmountMinor: number;
  /**
   * The euro amount that ARRIVED — the same figure unless the caller stated a
   * different one (see {@link TransferIntent.destinationAmountMinor}).
   */
  incomingAmountMinor: number;
  /** The acquisition cost that travelled, integer minor units. */
  inheritedCostMinor: number;
}

/** The violations this module can report, narrowed from the shared vocabulary. */
type TransferViolation = Extract<
  DomainViolation,
  {
    code:
      | "operation_fees_negative"
      | "transfer_amount_not_positive"
      | "transfer_origin_has_no_units"
      | "transfer_price_not_positive"
      | "transfer_same_holding"
      | "transfer_units_exceed_position"
      | "transfer_units_not_positive";
  }
>;

/** A refusal, shaped so it satisfies both this module's result types. */
function refuse(violation: TransferViolation): {
  ok: false;
  violations: [TransferViolation];
} {
  return { ok: false, violations: [violation] };
}

/**
 * One leg of the pair, resolved: the three figures its row and its card need, whichever
 * two of them were declared.
 *
 * Two of the three are always stated and the third is always derived — never two
 * derivations of the same figure, which is what keeps the importe reproducible to the
 * cent no matter which reading the user typed.
 */
interface ResolvedLeg {
  amountMinor: number;
  units: DecimalString;
  pricePerUnit: DecimalString;
}

type LegResolution =
  | { ok: true; leg: ResolvedLeg }
  | { ok: false; violations: [TransferViolation] };

/**
 * Resolve one traspaso into the pair of operations that records it, or the ONE
 * violation that refuses it.
 *
 * The arithmetic, and why each step is what it is:
 *
 * - **Each leg declares two of its three figures, and the third is derived** (#1544).
 *   Given participaciones and importe, the VL is `importe ÷ participaciones` at
 *   {@link PRICE_READBACK_DECIMALS} — the same derivation, for the same reason, as
 *   `InvestmentOperationPlan.pricePerUnit` on a buy: the cash figure the document
 *   states is reproduced to the cent, and the participaciones are the bank's own,
 *   not a division's. Given importe and VL, the participaciones are divided out
 *   instead. Declared participaciones RULE: they are the fact the confirmation
 *   prints, and the position IS participaciones — a VL rounded to fewer decimals than
 *   the bank publishes writes units that are permanently not the bank's, inherited by
 *   every later valuation, partial sale and traspaso.
 * - **A DIVIDED unit count is cut at the precision the app can read back**
 *   ({@link UNITS_READBACK_DECIMALS}, #1395); a DECLARED one is stored as stated. A
 *   raw division leaves twenty decimals that no bank publishes and that `formatUnits`
 *   cannot show, so the ficha would print a figure the ledger does not hold; a figure
 *   copied off a justificante is already at the bank's own precision.
 * - **The two legs are independent.** Each has its own importe (they genuinely
 *   differ, see {@link TransferIntent.destinationAmountMinor}) and its own reading:
 *   the origin can declare participaciones while the destination divides them, or
 *   both can, which is the shape of a real extracto — four figures, no VL typed.
 * - **«Todo» takes the position itself, not a division.** Cutting `importe ÷ VL` at
 *   six decimals leaves up to a millionth of a unit behind, and a fund the user
 *   emptied has to read as empty — a residual position is a phantom holding in every
 *   list, warning and donut. Its euro amount is the one the confirmation printed when
 *   there is one (and then the VL is derived from it), otherwise it is derived from
 *   those exact units at the stated VL.
 * - **The inherited cost is the same proportion the fold removes** (`proportionMinor`
 *   over the running weighted average, ADR 0040/0082). Computed here, once, and
 *   persisted on the incoming row: `derivePosition` folds ONE asset's ledger and
 *   must never cross over to the origin to learn it.
 * - **Units over the position are refused, not clamped** — declared or divided
 *   alike. The fold clamps an over-sell because it is reading a ledger it did not
 *   write; a gate is the last place that can still say no, and a traspaso the bank
 *   never executed must not enter the book at all. The violation carries both unit
 *   counts so the message can name them and offer «todo».
 *
 * Programmer errors still throw: two halves sharing one operation id would collide
 * on the primary key and leave the pair half-written, which is the single failure
 * mode this gate exists to prevent — no form can produce it, so it is a bug, not
 * data.
 */
export function planTransfer(
  intent: TransferIntent,
  origin: TransferOrigin,
): DomainResult<TransferPair> {
  if (intent.outOperationId === intent.inOperationId) {
    throw new Error("The two halves of a traspaso need distinct operation ids.");
  }

  if (intent.originAssetId === intent.destinationAssetId) {
    return refuse({ code: "transfer_same_holding" });
  }

  // A STATED VL is checked here, before either leg is resolved, so the refusals keep
  // the order they always had. A leg that declares its participaciones states no VL,
  // and its absence is answered by the leg itself — where it is known whether anything
  // else could have produced it.
  if (
    intent.originPricePerUnit !== undefined &&
    compareUnits(intent.originPricePerUnit, "0") <= 0
  ) {
    return refuse({ code: "transfer_price_not_positive", side: "origin" });
  }

  if (
    intent.destinationPricePerUnit !== undefined &&
    compareUnits(intent.destinationPricePerUnit, "0") <= 0
  ) {
    return refuse({ code: "transfer_price_not_positive", side: "destination" });
  }

  const feesMinor = intent.feesMinor ?? 0;
  assertMinorInteger(feesMinor);
  if (feesMinor < 0) {
    return refuse({ code: "operation_fees_negative" });
  }

  const resolved = resolveOriginLeg(intent, origin);
  if (!resolved.ok) return resolved;
  const out = resolved.leg;

  const arrived = resolveDestinationLeg(intent, out.amountMinor);
  if (!arrived.ok) return arrived;
  const incoming = arrived.leg;

  const inheritedCostMinor = proportionMinor(
    origin.costBasisMinor,
    out.units,
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
      incoming: {
        ...shared,
        assetId: intent.destinationAssetId,
        feesMinor,
        id: intent.inOperationId,
        kind: "transfer_in",
        pricePerUnit: incoming.pricePerUnit,
        transferCostMinor: inheritedCostMinor,
        units: incoming.units,
      },
      incomingAmountMinor: incoming.amountMinor,
      inheritedCostMinor,
      out: {
        ...shared,
        assetId: intent.originAssetId,
        feesMinor: 0,
        id: intent.outOperationId,
        kind: "transfer_out",
        pricePerUnit: out.pricePerUnit,
        units: out.units,
      },
      outgoingAmountMinor: out.amountMinor,
    },
  };
}

/**
 * The VL of a leg whose participaciones and importe are both stated: the derivation a
 * buy makes (`InvestmentOperationPlan.pricePerUnit`), except that no commission is
 * subtracted — on this instrument it rides the incoming half capitalized ON TOP of the
 * amount rather than inside it, so the amount that arrived is already the amount the
 * units stand for.
 *
 * A figure that rounds away to zero — an importe of cents spread over millions of
 * participaciones — is refused rather than stored: a row priced at 0 would value the
 * whole position at nothing.
 */
function deriveLegPrice(amountMinor: number, units: DecimalString): DecimalString | null {
  const price = divideUnits(minorToDecimal(amountMinor), units, PRICE_READBACK_DECIMALS);
  return compareUnits(price, "0") <= 0 ? null : price;
}

/**
 * One leg resolved from the two figures a confirmation prints: its participaciones and
 * its importe, with the VL derived (#1544).
 *
 * Shared by all three places that reading can arrive — the origin's `units` portion,
 * «todo» with a stated importe, and the destination's declared units — so the order of
 * the checks and the side each refusal names have ONE home. The units are NOT cut here:
 * a declared count is a fact the bank printed, and #1395's six decimals govern what the
 * app DERIVES.
 */
function resolveDeclaredLeg(
  amountMinor: number,
  units: DecimalString,
  side: "origin" | "destination",
): LegResolution {
  if (compareUnits(units, "0") <= 0) {
    return refuse({ code: "transfer_units_not_positive", side });
  }

  assertMinorInteger(amountMinor);
  if (amountMinor <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  const pricePerUnit = deriveLegPrice(amountMinor, units);
  if (pricePerUnit === null) {
    return refuse({ code: "transfer_price_not_positive", side });
  }

  return { leg: { amountMinor, pricePerUnit, units }, ok: true };
}

/**
 * The participaciones that leave, the euro amount they stand for, and the origin's VL
 * — from whichever two of the three the caller stated.
 */
function resolveOriginLeg(intent: TransferIntent, origin: TransferOrigin): LegResolution {
  const { portion } = intent;

  if (portion.kind === "units") {
    // The position check comes FIRST, before the figures are turned into a leg: a count
    // the origin never held is a traspaso the bank never executed, and saying so names
    // both counts instead of complaining about a VL that is fine.
    if (
      compareUnits(portion.units, "0") > 0 &&
      compareUnits(portion.units, origin.unitsHeld) > 0
    ) {
      return refuse({
        code: "transfer_units_exceed_position",
        unitsHeld: origin.unitsHeld,
        unitsRequested: portion.units,
      });
    }
    return resolveDeclaredLeg(portion.amountMinor, portion.units, "origin");
  }

  if (portion.kind === "all") {
    if (compareUnits(origin.unitsHeld, "0") <= 0) {
      return refuse({ code: "transfer_origin_has_no_units" });
    }

    if (portion.amountMinor !== undefined) {
      // «Todo» declares its participaciones by naming the position, so it resolves the
      // same way: the units are the position's own, exactly, and the VL comes from the
      // importe the confirmation printed for them.
      return resolveDeclaredLeg(portion.amountMinor, origin.unitsHeld, "origin");
    }

    if (intent.originPricePerUnit === undefined) {
      return refuse({ code: "transfer_price_not_positive", side: "origin" });
    }
    return {
      leg: {
        amountMinor: multiplyToMinor(origin.unitsHeld, intent.originPricePerUnit),
        pricePerUnit: intent.originPricePerUnit,
        units: origin.unitsHeld,
      },
      ok: true,
    };
  }

  if (intent.originPricePerUnit === undefined) {
    return refuse({ code: "transfer_price_not_positive", side: "origin" });
  }

  const { amountMinor } = portion;
  assertMinorInteger(amountMinor);
  if (amountMinor <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  const units = divideUnits(
    minorToDecimal(amountMinor),
    intent.originPricePerUnit,
    UNITS_READBACK_DECIMALS,
  );

  if (compareUnits(units, origin.unitsHeld) > 0) {
    return refuse({
      code: "transfer_units_exceed_position",
      unitsHeld: origin.unitsHeld,
      unitsRequested: units,
    });
  }

  return {
    leg: { amountMinor, pricePerUnit: intent.originPricePerUnit, units },
    ok: true,
  };
}

/**
 * The same three figures for the half that ARRIVES.
 *
 * Its importe is the one the caller stated or, absent, the one that left — the
 * ordinary case, and the only one a form needs to ask about. Its participaciones are
 * declared or divided at its own VL; a commission does not shrink them either way, it
 * is capitalized on top, exactly the shape of a buy where `units × price + fees` is
 * the cost.
 */
function resolveDestinationLeg(
  intent: TransferIntent,
  outgoingAmountMinor: number,
): LegResolution {
  const amountMinor = intent.destinationAmountMinor ?? outgoingAmountMinor;
  assertMinorInteger(amountMinor);
  if (amountMinor <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  if (intent.destinationUnits !== undefined) {
    return resolveDeclaredLeg(amountMinor, intent.destinationUnits, "destination");
  }

  if (intent.destinationPricePerUnit === undefined) {
    return refuse({ code: "transfer_price_not_positive", side: "destination" });
  }

  const units = divideUnits(
    minorToDecimal(amountMinor),
    intent.destinationPricePerUnit,
    UNITS_READBACK_DECIMALS,
  );

  if (compareUnits(units, "0") <= 0) {
    return refuse({ code: "transfer_amount_not_positive" });
  }

  return {
    leg: { amountMinor, pricePerUnit: intent.destinationPricePerUnit, units },
    ok: true,
  };
}

/**
 * The «alta por traspaso externo» (#1479): a plan or fund brought in from ANOTHER
 * institution, whose outgoing half lives outside this book entirely.
 *
 * It is a `transfer_in` with no pair — deliberately, not as a degraded traspaso. Jorge
 * did exactly this in enero 2026 («Traer plan desde otra entidad», 95,46 €) and will
 * again; the retyping pass of 19-ago found it and had to hand-write the row, because
 * the alternative readings are both wrong: a `buy` eats a year of contribution
 * allowance (ADR 0080) for capital that was merely moved, and half a real pair would
 * promise a `transfer_out` that no holding here can ever produce.
 *
 * It carries its own `transferId`, so readers that pair by that id find one row and can
 * say so — «entrada por traspaso externo» — instead of reporting a broken pair.
 *
 * The inherited cost is DECLARED, because nobody here can derive it: the origin's
 * ledger belongs to another institution. Its default is the amount that arrived, which
 * is the honest reading of "I do not know what these units cost" — it books no latent
 * gain rather than inventing one, and the user can correct it with a figure from the
 * old provider's statement.
 */
export interface ExternalTransferInIntent {
  /** This entry's own id. Present so a reader finds ONE row, not a broken pair. */
  transferId: string;
  inOperationId: string;
  destinationAssetId: string;
  /** YYYY-MM-DD the capital landed. */
  executedAt: string;
  /** The amount that arrived, integer minor units. */
  amountMinor: number;
  /** The destination's VL on `executedAt`. */
  destinationPricePerUnit: DecimalString;
  currency: CurrencyCode;
  /**
   * The acquisition cost these units carry, as the user declares it from the old
   * provider's paperwork. Defaults to {@link ExternalTransferInIntent.amountMinor}.
   */
  inheritedCostMinor?: number;
  /** A commission the entry was charged; capitalized, exactly as on a buy. */
  feesMinor?: number;
  source?: OperationSource;
  occurredAt?: string;
}

/**
 * Resolve an external entry into the ONE row that records it, or the violation that
 * refuses it. Same arithmetic and the same refusals as the incoming half of a pair —
 * only the origin is missing.
 */
export function planExternalTransferIn(
  intent: ExternalTransferInIntent,
): DomainResult<CreateInvestmentOperationInput> {
  if (compareUnits(intent.destinationPricePerUnit, "0") <= 0) {
    return {
      ok: false,
      violations: [{ code: "transfer_price_not_positive", side: "destination" }],
    };
  }

  assertMinorInteger(intent.amountMinor);
  if (intent.amountMinor <= 0) {
    return { ok: false, violations: [{ code: "transfer_amount_not_positive" }] };
  }

  const feesMinor = intent.feesMinor ?? 0;
  assertMinorInteger(feesMinor);
  if (feesMinor < 0) {
    return { ok: false, violations: [{ code: "operation_fees_negative" }] };
  }

  const inheritedCostMinor = intent.inheritedCostMinor ?? intent.amountMinor;
  assertMinorInteger(inheritedCostMinor);
  if (inheritedCostMinor < 0) {
    return { ok: false, violations: [{ code: "transfer_inherited_cost_negative" }] };
  }

  return {
    ok: true,
    value: {
      assetId: intent.destinationAssetId,
      currency: intent.currency,
      executedAt: intent.executedAt,
      feesMinor,
      id: intent.inOperationId,
      kind: "transfer_in",
      ...(intent.occurredAt === undefined ? {} : { occurredAt: intent.occurredAt }),
      pricePerUnit: intent.destinationPricePerUnit,
      ...(intent.source === undefined ? {} : { source: intent.source }),
      transferCostMinor: inheritedCostMinor,
      transferId: intent.transferId,
      units: divideUnits(
        minorToDecimal(intent.amountMinor),
        intent.destinationPricePerUnit,
        UNITS_READBACK_DECIMALS,
      ),
    },
  };
}
