/**
 * The order normalizer of the MyInvestor adapter (#1878) against the S1 fixtures
 * (#1887), read through the real reader. Figures from the fixtures are never written
 * here: each check compares the fixture with itself (orders against today's units)
 * or looks at shapes. The hand-made orders below use invented figures and codes.
 */

import { createMyInvestorClient } from "@pricing/myinvestor/client";
import type { MyInvestorOrder } from "@pricing/myinvestor/models";
import type { DateRange, MyInvestorReader } from "@pricing/myinvestor/reader";
import { fixtureTransport } from "@pricing/myinvestor/testing/fake-transport";
import { compareUnits } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import type {
  MyInvestorOperationFact,
  MyInvestorSkippedOrder,
  MyInvestorTransferLeg,
  MyInvestorUnpairedReason,
} from "./facts";
import {
  holdingKey,
  type MyInvestorAccountOrders,
  normalizeMyInvestorOrders,
  unitsByHolding,
} from "./normalize";

const TOKENS = { accessToken: "access-sintetico", refreshToken: "refresh-sintetico" };
const CAPTURE_RANGE: DateRange = { from: "2000-01-01", to: "2026-11-04" };
const SYNTHETIC_RANGE: DateRange = { from: "2000-01-01", to: "2025-06-20" };
const SYNTHETIC_FUND_ACCOUNT = "9100002";
const SYNTHETIC_PLAN_ACCOUNT = "9100003";

function reader(): MyInvestorReader {
  return createMyInvestorClient({
    transport: fixtureTransport(),
    deviceId: "device-sintetico",
  }).reader(TOKENS);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`Lectura fallida: ${JSON.stringify(result.error)}`);
  return result.value;
}

function operations(
  accounts: readonly MyInvestorAccountOrders[],
  onSkipped?: (skipped: MyInvestorSkippedOrder) => void,
): MyInvestorOperationFact[] {
  return normalizeMyInvestorOrders({ accounts, broker: [] }, onSkipped).map(
    (fact) => fact.payload,
  );
}

function bySourceType(
  facts: readonly MyInvestorOperationFact[],
  sourceType: string,
): MyInvestorOperationFact[] {
  return facts.filter((fact) => fact.sourceType === sourceType);
}

let invented = 0;
/** A finished fund order with invented figures. */
function order(overrides: Partial<MyInvestorOrder>): MyInvestorOrder {
  invented += 1;
  return {
    reference: `ref-inventada-${invented}`,
    accountId: "cuenta-inventada",
    orderDate: "2025-03-10",
    isin: "ES0000000001",
    dgsCode: null,
    ticker: null,
    fundName: null,
    operationType: "INVESTMENT_FUNDS_SUBSCRIPTION",
    orderType: "ORDINARY",
    status: "COMPLETE",
    cash: "100.5",
    shares: "10.05",
    executionNav: "10",
    amountToBlock: "100.5",
    currency: "EUR",
    productType: "IIC",
    market: null,
    effectiveDate: null,
    expirationDate: null,
    ...overrides,
  };
}

/** What a leg without its other half carries: its own id, and on the way in, a pending cost. */
function unpairedLeg(
  fact: MyInvestorOperationFact | undefined,
  reason: MyInvestorUnpairedReason,
): MyInvestorTransferLeg {
  return {
    pairing: "unpaired",
    reason,
    transferId: `myinvestor-unpaired:${fact?.reference}`,
    inheritedCost: fact?.operation === "transfer_in" ? "pending" : null,
  };
}

function fundAccount(orders: MyInvestorOrder[]): MyInvestorAccountOrders {
  return { accountId: "cuenta-inventada", product: "fund", orders };
}

function planAccount(orders: MyInvestorOrder[]): MyInvestorAccountOrders {
  return { accountId: "plan-inventado", product: "pension_plan", orders };
}

describe("P8: the finished orders rebuild today's units exactly", () => {
  it("every plan of the captured pension accounts", async () => {
    const read = reader();
    const accounts = unwrap(await read.pensionAccounts());
    expect(accounts.length).toBeGreaterThan(0);

    for (const account of accounts) {
      const orders = unwrap(await read.pensionOrders(account.accountId, CAPTURE_RANGE));
      const plans = unwrap(await read.pensionPlans(account.accountId));
      const facts = normalizeMyInvestorOrders({
        accounts: [{ accountId: account.accountId, product: "pension_plan", orders }],
        broker: [],
      });
      const units = unitsByHolding(facts.map((fact) => fact.payload));

      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) {
        const key = holdingKey(account.accountId, { scheme: "dgs", code: plan.dgsCode });
        const folded = units.get(key);
        expect(folded, plan.dgsCode).toBeDefined();
        expect(compareUnits(folded ?? "0", plan.shares), plan.dgsCode).toBe(0);
      }
      expect(units.size).toBe(plans.length);
    }
  });

  it("the synthetic fund account with an internal switch", async () => {
    const read = reader();
    const orders = unwrap(
      await read.securitiesOrders(SYNTHETIC_FUND_ACCOUNT, SYNTHETIC_RANGE),
    );
    const today = unwrap(await read.securitiesAccount(SYNTHETIC_FUND_ACCOUNT));
    const units = unitsByHolding(
      operations([{ accountId: SYNTHETIC_FUND_ACCOUNT, product: "fund", orders }]),
    );

    const held = today.positions.filter((position) => compareUnits(position.shares, "0"));
    expect(held.length).toBeGreaterThan(0);
    for (const position of held) {
      const key = holdingKey(SYNTHETIC_FUND_ACCOUNT, {
        scheme: "isin",
        code: position.isin ?? "",
      });
      expect(compareUnits(units.get(key) ?? "0", position.shares), key).toBe(0);
    }
  });

  it("the synthetic plan opened by an external mobilization", async () => {
    const read = reader();
    const orders = unwrap(
      await read.pensionOrders(SYNTHETIC_PLAN_ACCOUNT, SYNTHETIC_RANGE),
    );
    const plans = unwrap(await read.pensionPlans(SYNTHETIC_PLAN_ACCOUNT));
    const units = unitsByHolding(
      operations([
        { accountId: SYNTHETIC_PLAN_ACCOUNT, product: "pension_plan", orders },
      ]),
    );

    for (const plan of plans) {
      const key = holdingKey(SYNTHETIC_PLAN_ACCOUNT, {
        scheme: "dgs",
        code: plan.dgsCode,
      });
      expect(compareUnits(units.get(key) ?? "0", plan.shares), key).toBe(0);
    }
  });
});

describe("only finished orders become facts", () => {
  it("an order in progress or rejected produces no fact", () => {
    const facts = operations([
      fundAccount([
        order({ reference: "en-curso", status: "IN_PROGRESS" }),
        order({ reference: "rechazada", status: "REJECTED" }),
        order({ reference: "hecha" }),
      ]),
    ]);

    expect(facts.map((fact) => fact.reference)).toEqual(["hecha"]);
  });

  it("the captured and synthetic in-progress orders never reach the facts", async () => {
    const read = reader();
    const orders = unwrap(
      await read.securitiesOrders(SYNTHETIC_FUND_ACCOUNT, SYNTHETIC_RANGE),
    );
    const unfinished = orders.filter((candidate) => candidate.status !== "COMPLETE");
    expect(unfinished.length).toBeGreaterThan(0);

    const references = new Set(
      operations([{ accountId: SYNTHETIC_FUND_ACCOUNT, product: "fund", orders }]).map(
        (fact) => fact.reference,
      ),
    );
    for (const candidate of unfinished) {
      expect(references.has(candidate.reference)).toBe(false);
    }
  });
});

describe("the vocabulary of the investment commands", () => {
  it("a fund subscription is a buy at its NAV, keyed by its reference, dated on the order day", () => {
    const [fact] = normalizeMyInvestorOrders({
      accounts: [fundAccount([order({ reference: "suscripcion-1" })])],
      broker: [],
    });

    expect(fact?.key).toBe("suscripcion-1");
    expect(fact?.dateKey).toBe("2025-03-10");
    expect(fact?.payload).toMatchObject({
      kind: "operation",
      product: "fund",
      accountId: "cuenta-inventada",
      instrument: { scheme: "isin", code: "ES0000000001" },
      operation: "buy",
      executedAt: "2025-03-10",
      units: "10.05",
      pricePerUnit: "10",
      amount: "100.5",
      fees: "0",
      currency: "EUR",
      transfer: null,
    });
  });

  it("a plan contribution is a buy of the plan by its DGS code, never an ISIN", () => {
    const [fact] = operations([
      planAccount([
        order({
          operationType: "PLAN_CONTRIBUTION",
          isin: null,
          dgsCode: "N0001",
          productType: "PLP",
        }),
      ]),
    ]);

    expect(fact?.operation).toBe("buy");
    expect(fact?.product).toBe("pension_plan");
    expect(fact?.instrument).toEqual({ scheme: "dgs", code: "N0001" });
  });

  it("a fund reimbursement is a sell", () => {
    const [fact] = operations([
      fundAccount([order({ operationType: "INVESTMENT_FUNDS_REIMBURSEMENT" })]),
    ]);
    expect(fact?.operation).toBe("sell");
  });

  it("units are always positive; the operation says which way they move", () => {
    const [fact] = operations([
      fundAccount([
        order({ operationType: "INVESTMENT_FUNDS_REIMBURSEMENT", shares: "-3.5" }),
      ]),
    ]);
    expect(fact?.units).toBe("3.5");
  });

  it("an unknown operation type is reported, not guessed", () => {
    const skipped: MyInvestorSkippedOrder[] = [];
    const facts = operations(
      [fundAccount([order({ reference: "rara", operationType: "SOMETHING_NEW" })])],
      (entry) => skipped.push(entry),
    );

    expect(facts).toEqual([]);
    expect(skipped).toEqual([
      {
        reference: "rara",
        product: "fund",
        sourceType: "SOMETHING_NEW",
        reason: "unrecognized_type",
      },
    ]);
  });

  it("a plan order without its DGS code or a finished order with no units is reported", () => {
    const skipped: MyInvestorSkippedOrder[] = [];
    operations(
      [
        planAccount([
          order({ reference: "sin-dgs", operationType: "PLAN_CONTRIBUTION", isin: null }),
        ]),
        fundAccount([order({ reference: "sin-participaciones", shares: "0" })]),
      ],
      (entry) => skipped.push(entry),
    );

    expect(skipped.map((entry) => [entry.reference, entry.reason])).toEqual([
      ["sin-dgs", "missing_instrument"],
      ["sin-participaciones", "no_units"],
    ]);
  });
});

describe("traspasos", () => {
  it("an internal plan mobilization: both legs carry the same transferId", async () => {
    const read = reader();
    const [account] = unwrap(await read.pensionAccounts());
    const orders = unwrap(
      await read.pensionOrders(account?.accountId ?? "", CAPTURE_RANGE),
    );
    const facts = operations([
      { accountId: account?.accountId ?? "", product: "pension_plan", orders },
    ]);

    const [out] = bySourceType(facts, "DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER");
    const [incoming] = bySourceType(facts, "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER");
    expect(out?.operation).toBe("transfer_out");
    expect(incoming?.operation).toBe("transfer_in");
    expect(out?.transfer?.pairing).toBe("paired");
    expect(incoming?.transfer?.pairing).toBe("paired");
    if (out?.transfer?.pairing !== "paired" || incoming?.transfer?.pairing !== "paired") {
      throw new Error("unpaired");
    }
    expect(out.transfer.transferId).toBe(incoming.transfer.transferId);
    expect(out.transfer.counterpartKey).toBe(incoming.reference);
    expect(incoming.transfer.counterpartKey).toBe(out.reference);
    expect(out.instrument).not.toEqual(incoming.instrument);
  });

  it("an internal fund switch: both legs carry the same transferId", async () => {
    const read = reader();
    const orders = unwrap(
      await read.securitiesOrders(SYNTHETIC_FUND_ACCOUNT, SYNTHETIC_RANGE),
    );
    const facts = operations([
      { accountId: SYNTHETIC_FUND_ACCOUNT, product: "fund", orders },
    ]);

    const [out] = bySourceType(facts, "IIC_SWITCH_DEREGISTRATION");
    const [incoming] = bySourceType(facts, "IIC_SWITCH_REGISTRATION");
    expect(out?.operation).toBe("transfer_out");
    expect(incoming?.operation).toBe("transfer_in");
    expect(out?.transfer).toMatchObject({ pairing: "paired" });
    expect(incoming?.transfer).toEqual({
      ...out?.transfer,
      counterpartKey: out?.reference,
    });
  });

  it("the captured fund switch pairs too", async () => {
    const read = reader();
    const summaries = unwrap(await read.securitiesAccounts());
    const facts: MyInvestorOperationFact[] = [];
    for (const summary of summaries) {
      const orders = unwrap(
        await read.securitiesOrders(summary.accountId, CAPTURE_RANGE),
      );
      facts.push(
        ...operations([{ accountId: summary.accountId, product: "fund", orders }]),
      );
    }

    const legs = facts.filter((fact) => fact.sourceType.startsWith("IIC_SWITCH_"));
    expect(legs.length).toBe(2);
    expect(legs.every((leg) => leg.transfer?.pairing === "paired")).toBe(true);
  });

  it("an external mobilization in is a transfer_in with its inherited cost pending, nothing invented", async () => {
    const read = reader();
    const orders = unwrap(
      await read.pensionOrders(SYNTHETIC_PLAN_ACCOUNT, SYNTHETIC_RANGE),
    );
    const facts = operations([
      { accountId: SYNTHETIC_PLAN_ACCOUNT, product: "pension_plan", orders },
    ]);

    const [entry] = bySourceType(facts, "REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER");
    expect(entry?.operation).toBe("transfer_in");
    expect(entry?.instrument.scheme).toBe("dgs");
    expect(entry?.pricePerUnit).toBeNull();
    expect(entry?.amount).toBeNull();
    expect(compareUnits(entry?.units ?? "0", "0")).toBe(1);
    expect(entry?.transfer).toEqual({
      pairing: "external_in",
      transferId: `myinvestor-external:${entry?.reference}`,
      inheritedCost: "pending",
    });
  });

  it("legs that differ in amount do not pair", () => {
    const facts = operations([
      planAccount([
        order({
          reference: "baja",
          operationType: "DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
          isin: null,
          dgsCode: "N0001",
          cash: "500.25",
        }),
        order({
          reference: "alta",
          operationType: "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
          isin: null,
          dgsCode: "N0002",
          cash: "500.26",
        }),
      ]),
    ]);

    // Alone, each leg still names its traspaso, and the incoming one asks for its
    // inherited cost: its amount is the value that moved, never a cost (#1869 P1).
    expect(facts.map((fact) => fact.transfer)).toEqual([
      {
        pairing: "unpaired",
        reason: "no_counterpart",
        transferId: "myinvestor-unpaired:baja",
        inheritedCost: null,
      },
      {
        pairing: "unpaired",
        reason: "no_counterpart",
        transferId: "myinvestor-unpaired:alta",
        inheritedCost: "pending",
      },
    ]);
  });

  it("legs of the same instrument, another day or another account do not pair", () => {
    const out = {
      operationType: "IIC_SWITCH_DEREGISTRATION",
      isin: "ES0000000001",
    } as const;
    const facts = operations([
      fundAccount([
        order({ reference: "a-out", ...out }),
        order({ reference: "a-in", operationType: "IIC_SWITCH_REGISTRATION" }),
        order({ reference: "b-out", ...out, orderDate: "2025-04-01" }),
        order({
          reference: "b-in",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000002",
          orderDate: "2025-04-02",
        }),
      ]),
      {
        accountId: "otra-cuenta",
        product: "fund",
        orders: [
          order({
            reference: "c-in",
            operationType: "IIC_SWITCH_REGISTRATION",
            isin: "ES0000000003",
            orderDate: "2025-04-01",
          }),
        ],
      },
    ]);

    for (const fact of facts) {
      expect(fact.transfer, fact.reference).toEqual(unpairedLeg(fact, "no_counterpart"));
    }
  });

  it("two legs that fit the same other half are ambiguous, never paired by guess", () => {
    const facts = operations([
      fundAccount([
        order({ reference: "out-1", operationType: "IIC_SWITCH_DEREGISTRATION" }),
        order({
          reference: "in-1",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000002",
        }),
        order({
          reference: "in-2",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000003",
        }),
      ]),
    ]);

    expect(facts.map((fact) => fact.reference)).toEqual(["out-1", "in-1", "in-2"]);
    for (const fact of facts) {
      expect(fact.transfer, fact.reference).toEqual(unpairedLeg(fact, "ambiguous"));
    }
  });

  it("a finished leg whose other half is still in progress waits for it", () => {
    const pair = [
      order({ reference: "sale", operationType: "IIC_SWITCH_DEREGISTRATION" }),
      order({
        reference: "entra",
        operationType: "IIC_SWITCH_REGISTRATION",
        isin: "ES0000000002",
        status: "IN_PROGRESS",
      }),
    ];
    expect(operations([fundAccount(pair)])).toEqual([]);

    // Once both are finished, the next (overlapping) read pairs them.
    const later = operations([
      fundAccount(pair.map((leg) => ({ ...leg, status: "COMPLETE" }))),
    ]);
    expect(later.map((fact) => fact.transfer?.pairing)).toEqual(["paired", "paired"]);
  });

  it("a finished other half that produced no fact is not a pair", () => {
    const facts = operations([
      fundAccount([
        order({ reference: "sale", operationType: "IIC_SWITCH_DEREGISTRATION" }),
        order({
          reference: "vacia",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000002",
          shares: "0",
        }),
      ]),
    ]);
    expect(facts.map((fact) => fact.reference)).toEqual(["sale"]);
    expect(facts[0]?.transfer).toEqual(unpairedLeg(facts[0], "no_counterpart"));
  });

  it("only an other half in progress holds a leg back: an unknown status never stalls it", () => {
    const facts = operations([
      fundAccount([
        order({ reference: "sale", operationType: "IIC_SWITCH_DEREGISTRATION" }),
        order({
          reference: "rara",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000002",
          status: "EXPIRED",
        }),
        order({
          reference: "sin-estado",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000003",
          status: null,
        }),
      ]),
    ]);
    expect(facts.map((fact) => fact.reference)).toEqual(["sale"]);
    expect(facts[0]?.transfer).toEqual(unpairedLeg(facts[0], "no_counterpart"));
  });

  it("a rejected other half does not hold a leg back", () => {
    const facts = operations([
      fundAccount([
        order({ reference: "sale", operationType: "IIC_SWITCH_DEREGISTRATION" }),
        order({
          reference: "rechazada",
          operationType: "IIC_SWITCH_REGISTRATION",
          isin: "ES0000000002",
          status: "REJECTED",
        }),
      ]),
    ]);
    expect(facts.map((fact) => fact.reference)).toEqual(["sale"]);
    expect(facts[0]?.transfer).toEqual(unpairedLeg(facts[0], "no_counterpart"));
  });

  it("INTERNAL_TRANSFER_* legs stay explicitly unpaired: nothing safe ties them", async () => {
    const read = reader();
    const summaries = unwrap(await read.securitiesAccounts());
    const facts: MyInvestorOperationFact[] = [];
    for (const summary of summaries) {
      const orders = unwrap(
        await read.securitiesOrders(summary.accountId, CAPTURE_RANGE),
      );
      facts.push(
        ...operations([{ accountId: summary.accountId, product: "fund", orders }]),
      );
    }

    const legs = facts.filter((fact) => fact.sourceType.startsWith("INTERNAL_TRANSFER_"));
    expect(legs.map((leg) => leg.operation).sort()).toEqual([
      "transfer_in",
      "transfer_out",
    ]);
    for (const leg of legs) {
      expect(leg.transfer).toEqual(unpairedLeg(leg, "no_common_reference"));
    }
  });
});

describe("dedup keys and transfer ids are stable across overlapping reads", () => {
  it("re-reading a window that overlaps the last one yields the same keys and ids", async () => {
    const read = reader();
    const [account] = unwrap(await read.pensionAccounts());
    const orders = unwrap(
      await read.pensionOrders(account?.accountId ?? "", CAPTURE_RANGE),
    );
    const book = (subset: MyInvestorOrder[]) =>
      normalizeMyInvestorOrders({
        accounts: [
          {
            accountId: account?.accountId ?? "",
            product: "pension_plan",
            orders: subset,
          },
        ],
        broker: [],
      });

    const full = book(orders);
    const transferDay = full.find(
      (fact) => fact.payload.sourceType === "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
    )?.dateKey;
    const recent = book(
      orders.filter((candidate) => candidate.orderDate >= (transferDay ?? "")),
    );

    const fullByKey = new Map(full.map((fact) => [fact.key, fact]));
    expect(recent.length).toBeGreaterThan(0);
    for (const fact of recent) {
      expect(fullByKey.get(fact.key)).toEqual(fact);
    }
  });
});
