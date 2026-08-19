/**
 * The arithmetic and the refusals of a traspaso, before anything is written
 * (#1479, PRD #1393). Everything here is pure: the gate that owns the transaction
 * folds the origin's ledger and hands the result in.
 */

import { describe, expect, test } from "vitest";

import type { TransferIntent, TransferOrigin } from "./transfer-plan";
import { planExternalTransferIn, planTransfer } from "./transfer-plan";

const INTENT: TransferIntent = {
  currency: "EUR",
  destinationAssetId: "destino",
  destinationPricePerUnit: "319.59",
  executedAt: "2026-07-31",
  inOperationId: "op_in",
  originAssetId: "origen",
  originPricePerUnit: "21.24",
  outOperationId: "op_out",
  portion: { amountMinor: 101_867, kind: "amount" },
  transferId: "trf_1",
};

/** Jorge's real case: 47,96 part. bought at ~15 €, worth 21,24 € on the day. */
const ORIGIN: TransferOrigin = {
  costBasisMinor: 71_940,
  unitsHeld: "47.96",
};

function plan(
  intent: Partial<TransferIntent> = {},
  origin: Partial<TransferOrigin> = {},
) {
  return planTransfer({ ...INTENT, ...intent }, { ...ORIGIN, ...origin });
}

describe("planTransfer — the pair the gate will write", () => {
  test("both halves carry the same date, the same transferId, and their own asset", () => {
    const result = plan();
    if (!result.ok) throw new Error("expected a plan");

    expect(result.value.out).toMatchObject({
      assetId: "origen",
      currency: "EUR",
      executedAt: "2026-07-31",
      kind: "transfer_out",
      pricePerUnit: "21.24",
      transferId: "trf_1",
    });
    expect(result.value.incoming).toMatchObject({
      assetId: "destino",
      currency: "EUR",
      executedAt: "2026-07-31",
      kind: "transfer_in",
      pricePerUnit: "319.59",
      transferId: "trf_1",
    });
  });

  test("the units of each half are the amount over ITS own VL, cut where the app can read them", () => {
    const result = plan();
    if (!result.ok) throw new Error("expected a plan");

    // 1.018,67 € ÷ 21,24 € and ÷ 319,59 € — six decimals, not the twenty a raw
    // division would leave behind (#1395).
    expect(result.value.out.units).toBe("47.959981");
    expect(result.value.incoming.units).toBe("3.187428");
  });

  test("the outgoing half carries no fees and no inherited cost", () => {
    const result = plan({ feesMinor: 500 });
    if (!result.ok) throw new Error("expected a plan");

    // A traspaso commission has exactly one home: the destination, capitalized as
    // on a buy. The outgoing half realizes no P/L to charge it against (ADR 0082).
    expect(result.value.out.feesMinor).toBe(0);
    expect(result.value.out.transferCostMinor).toBeUndefined();
    expect(result.value.incoming.feesMinor).toBe(500);
  });

  test("the incoming half inherits the origin's proportional cost, not the amount moved", () => {
    const result = plan();
    if (!result.ok) throw new Error("expected a plan");

    // 719,40 € of cost over 47,96 part., of which 47,959981 leave: essentially all
    // of it. What must NOT happen is the destination being born at 1.018,67 € —
    // that is the latent gain vanishing from the book.
    expect(result.value.incoming.transferCostMinor).toBe(71_940);
    expect(result.value.inheritedCostMinor).toBe(71_940);
    expect(result.value.outgoingAmountMinor).toBe(101_867);
    expect(result.value.incomingAmountMinor).toBe(101_867);
  });

  test("the inherited cost is a SLICE when only part of the position moves", () => {
    // Half the units at the same VL: half the cost travels, half stays.
    const result = plan({ portion: { amountMinor: 50_933, kind: "amount" } });
    if (!result.ok) throw new Error("expected a plan");

    expect(result.value.out.units).toBe("23.979755");
    expect(result.value.incoming.transferCostMinor).toBe(35_970);
  });

  test("«todo» liquidates the origin exactly — no residual dust", () => {
    const result = plan({ portion: { kind: "all" } });
    if (!result.ok) throw new Error("expected a plan");

    // The units are the position itself, NOT amount ÷ VL: a division cut at six
    // decimals leaves a millionth of a unit behind, and a fund the user emptied
    // must read as empty.
    expect(result.value.out.units).toBe("47.96");
    expect(result.value.inheritedCostMinor).toBe(ORIGIN.costBasisMinor);
    // The euro figure is derived from those exact units at the origin's VL.
    expect(result.value.outgoingAmountMinor).toBe(101_867);
    expect(result.value.incomingAmountMinor).toBe(101_867);
    expect(result.value.incoming.units).toBe("3.187428");
  });

  test("«todo» on an empty position is refused, not written as zero units", () => {
    const result = plan(
      { portion: { kind: "all" } },
      { costBasisMinor: 0, unitsHeld: "0" },
    );
    expect(result).toEqual({
      ok: false,
      violations: [{ code: "transfer_origin_has_no_units" }],
    });
  });

  test("the two halves may state DIFFERENT amounts — the ids tie them, not the money", () => {
    // Jorge's real 14-ago traspaso: 739,22 € left, 740,72 € arrived, because the origin
    // is valued the day the capital leaves and the destination the day it lands. Forcing
    // one figure on both would buy 1,50 € of participaciones nobody paid for.
    const result = plan({
      destinationAmountMinor: 74_072,
      portion: { amountMinor: 73_922, kind: "amount" },
    });
    if (!result.ok) throw new Error("expected a plan");

    expect(result.value.outgoingAmountMinor).toBe(73_922);
    expect(result.value.incomingAmountMinor).toBe(74_072);
    // Each half's units come from its OWN amount over its own VL.
    expect(result.value.out.units).toBe("34.803202");
    expect(result.value.incoming.units).toBe("2.31772");
    // The inherited cost still comes from the ORIGIN's ledger — the amount that
    // arrived says nothing about what the units cost.
    expect(result.value.incoming.transferCostMinor).toBe(result.value.inheritedCostMinor);
  });

  test("an arriving amount of zero is refused like a departing one", () => {
    expect(plan({ destinationAmountMinor: 0 })).toEqual({
      ok: false,
      violations: [{ code: "transfer_amount_not_positive" }],
    });
  });

  test("the source and the source instant ride both halves", () => {
    const result = plan({ occurredAt: "2026-07-31T07:58:36.000Z", source: "agent" });
    if (!result.ok) throw new Error("expected a plan");

    expect(result.value.out.source).toBe("agent");
    expect(result.value.incoming.source).toBe("agent");
    expect(result.value.out.occurredAt).toBe("2026-07-31T07:58:36.000Z");
    expect(result.value.incoming.occurredAt).toBe("2026-07-31T07:58:36.000Z");
  });
});

describe("planTransfer — the refusals", () => {
  test("an amount of zero or less has nothing to move", () => {
    expect(plan({ portion: { amountMinor: 0, kind: "amount" } })).toEqual({
      ok: false,
      violations: [{ code: "transfer_amount_not_positive" }],
    });
    expect(plan({ portion: { amountMinor: -101_867, kind: "amount" } })).toEqual({
      ok: false,
      violations: [{ code: "transfer_amount_not_positive" }],
    });
  });

  test("a VL of zero would divide by nothing — each side names itself", () => {
    expect(plan({ originPricePerUnit: "0" })).toEqual({
      ok: false,
      violations: [{ code: "transfer_price_not_positive", side: "origin" }],
    });
    expect(plan({ destinationPricePerUnit: "0" })).toEqual({
      ok: false,
      violations: [{ code: "transfer_price_not_positive", side: "destination" }],
    });
    expect(plan({ originPricePerUnit: "-21.24" })).toEqual({
      ok: false,
      violations: [{ code: "transfer_price_not_positive", side: "origin" }],
    });
  });

  test("an amount larger than the position is refused, never clamped", () => {
    const result = plan({ portion: { amountMinor: 200_000, kind: "amount" } });

    // The position fold CLAMPS an over-sell with a warning, because it is reading a
    // ledger it did not write. A gate is the one place that can still say no, and a
    // traspaso the bank never executed must not enter the book at all.
    expect(result).toEqual({
      ok: false,
      violations: [
        {
          code: "transfer_units_exceed_position",
          unitsHeld: "47.96",
          unitsRequested: "94.161959",
        },
      ],
    });
  });

  test("one cent over the position is refused too — the gate does not round the gap away", () => {
    // The nudge that would be tempting to tolerate: the bank's figure divides into
    // 47,960028 participaciones and only 47,96 exist. Writing the 47,96 the fold
    // would clamp to means storing an amount the user never said; refusing means
    // asking whether they meant «todo», which is the question they can answer.
    const result = plan({ portion: { amountMinor: 101_868, kind: "amount" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toMatchObject({
      code: "transfer_units_exceed_position",
      unitsHeld: "47.96",
    });
  });

  test("a holding cannot be traspasado to itself", () => {
    expect(plan({ destinationAssetId: "origen" })).toEqual({
      ok: false,
      violations: [{ code: "transfer_same_holding" }],
    });
  });

  test("«origen sin unidades» reads as an over-position amount, and says how many", () => {
    // The `all` branch has its own violation; an `amount` against an empty position
    // lands here, naming a zero position instead of a missing one.
    expect(
      plan(
        { portion: { amountMinor: 101_867, kind: "amount" } },
        { costBasisMinor: 0, unitsHeld: "0" },
      ),
    ).toEqual({
      ok: false,
      violations: [
        {
          code: "transfer_units_exceed_position",
          unitsHeld: "0",
          unitsRequested: "47.959981",
        },
      ],
    });
  });

  test("negative fees are refused like on any other operation", () => {
    expect(plan({ feesMinor: -500 })).toEqual({
      ok: false,
      violations: [{ code: "operation_fees_negative" }],
    });
  });

  test("the two halves cannot share one operation id", () => {
    // They would collide on the primary key and the pair would be half-written —
    // the one failure mode the gate exists to prevent, caught before the write.
    expect(() => plan({ inOperationId: "op_out" })).toThrow(/operation id/);
  });
});

describe("planExternalTransferIn — la mitad que no tiene pareja", () => {
  const EXTERNAL = {
    amountMinor: 9_546,
    currency: "EUR" as const,
    destinationAssetId: "plan_traido",
    destinationPricePerUnit: "12.5",
    executedAt: "2026-01-23",
    inOperationId: "op_ext",
    transferId: "trf_ext",
  };

  test("writes ONE transfer_in with its own transferId and no origin", () => {
    const result = planExternalTransferIn(EXTERNAL);
    if (!result.ok) throw new Error("expected a plan");

    // Jorge's real 23-ene entry: a plan brought from another institution. It is a
    // `transfer_in` on purpose — a `buy` would eat a year of contribution allowance
    // (ADR 0080) for capital that was only moved.
    expect(result.value).toMatchObject({
      assetId: "plan_traido",
      executedAt: "2026-01-23",
      kind: "transfer_in",
      transferId: "trf_ext",
      units: "7.6368",
    });
  });

  test("the inherited cost defaults to what arrived — no invented latent gain", () => {
    const result = planExternalTransferIn(EXTERNAL);
    if (!result.ok) throw new Error("expected a plan");
    expect(result.value.transferCostMinor).toBe(9_546);
  });

  test("a declared inherited cost wins — that is the old provider's figure", () => {
    const result = planExternalTransferIn({ ...EXTERNAL, inheritedCostMinor: 7_000 });
    if (!result.ok) throw new Error("expected a plan");
    // 25,46 € of latent gain travels, which is what the entry is FOR.
    expect(result.value.transferCostMinor).toBe(7_000);
  });

  test("the refusals it shares with a pair's incoming half", () => {
    expect(planExternalTransferIn({ ...EXTERNAL, amountMinor: 0 })).toEqual({
      ok: false,
      violations: [{ code: "transfer_amount_not_positive" }],
    });
    expect(planExternalTransferIn({ ...EXTERNAL, destinationPricePerUnit: "0" })).toEqual(
      {
        ok: false,
        violations: [{ code: "transfer_price_not_positive", side: "destination" }],
      },
    );
    expect(planExternalTransferIn({ ...EXTERNAL, inheritedCostMinor: -1 })).toEqual({
      ok: false,
      violations: [{ code: "transfer_inherited_cost_negative" }],
    });
  });
});
