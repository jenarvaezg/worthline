/**
 * One debt's curve input, assembled from its rows (#1848).
 *
 * The board (`readDebtBalanceInputs`, every live debt at once) and the ficha (the
 * rows of ONE debt it already read to render them) used to build this object each
 * in its own way. Both now ask `debtBalanceCurveInput`, so the figure on the ficha's
 * header is the board row's by construction. These tests pin the shape per model,
 * and that the board's batch read still hands out exactly what it did before.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { readDebtBalanceInputs } from "./curve-valued-holdings";
import { debtBalanceCurveInput } from "./debt-balance-input";
import { openDrizzle, openLibsqlClient } from "./libsql-client";
import { createStoreFromSqlite, type PersistenceTestStore } from "./testing";

const PLAN_ROW = {
  annualInterestRate: "0.03",
  disbursementDate: "2020-01-15",
  firstPaymentDate: "2020-03-01",
  id: "plan_1",
  initialCapitalMinor: 200_000_00,
  liabilityId: "l_1",
  originalSigningDate: null,
  termMonths: 240,
};

const REBASELINE_ROW = {
  annualInterestRate: "0.0325",
  baselineDate: "2026-01-01",
  endDate: "2030-01-01",
  id: "reb_1",
  liabilityId: "l_1",
  nextPaymentDate: "2026-02-01",
  outstandingBalanceMinor: 90_000_00,
  startsAtBaseline: true,
};

/** Rows as the stores hand them out: with the plumbing the curve must not carry. */
const REPAYMENT_ROW = {
  amountMinor: 10_000_00,
  id: "rep_1",
  mode: "reduce-term" as const,
  planId: "plan_1",
  repaymentDate: "2023-05-01",
};

const REVISION_ROW = {
  id: "rev_1",
  newAnnualInterestRate: "0.04",
  planId: "plan_1",
  revisionDate: "2022-01-01",
};

const ANCHOR_ROW = {
  anchorDate: "2026-07-01",
  balanceMinor: 1_200_00,
  id: "a_1",
  liabilityId: "l",
};

const NO_ROWS = {
  anchors: [],
  balanceRebaselines: [],
  cadence: null,
  earlyRepayments: [],
  plan: null,
  revisions: [],
};

describe("debtBalanceCurveInput", () => {
  test("a debt with no model has no curve: the stored balance is its figure", () => {
    expect(
      debtBalanceCurveInput({
        ...NO_ROWS,
        currentBalanceMinor: 5_000_00,
        debtModel: null,
      }),
    ).toBeNull();
  });

  test("an amortizable debt carries its plan, its dated events and its re-baselines — and nothing of the rows' plumbing", () => {
    expect(
      debtBalanceCurveInput({
        ...NO_ROWS,
        balanceRebaselines: [REBASELINE_ROW],
        cadence: "interpolated",
        currentBalanceMinor: 180_000_00,
        debtModel: "amortizable",
        earlyRepayments: [REPAYMENT_ROW],
        // Anchors belong to the other models: an amortizable curve never reads them.
        anchors: [ANCHOR_ROW],
        plan: PLAN_ROW,
        revisions: [REVISION_ROW],
      }),
    ).toEqual({
      balanceRebaselines: [
        {
          annualInterestRate: "0.0325",
          baselineDate: "2026-01-01",
          endDate: "2030-01-01",
          nextPaymentDate: "2026-02-01",
          outstandingBalanceMinor: 90_000_00,
          startsAtBaseline: true,
        },
      ],
      cadence: "interpolated",
      currentBalanceMinor: 180_000_00,
      debtModel: "amortizable",
      earlyRepayments: [
        { amountMinor: 10_000_00, mode: "reduce-term", repaymentDate: "2023-05-01" },
      ],
      plan: {
        annualInterestRate: "0.03",
        disbursementDate: "2020-01-15",
        firstPaymentDate: "2020-03-01",
        initialCapitalMinor: 200_000_00,
        termMonths: 240,
      },
      revisions: [{ newAnnualInterestRate: "0.04", revisionDate: "2022-01-01" }],
    });
  });

  test("an amortizable debt with no plan row keeps only its re-baselines", () => {
    expect(
      debtBalanceCurveInput({
        ...NO_ROWS,
        balanceRebaselines: [REBASELINE_ROW],
        currentBalanceMinor: 90_000_00,
        debtModel: "amortizable",
      }),
    ).toEqual({
      balanceRebaselines: [
        {
          annualInterestRate: "0.0325",
          baselineDate: "2026-01-01",
          endDate: "2030-01-01",
          nextPaymentDate: "2026-02-01",
          outstandingBalanceMinor: 90_000_00,
          startsAtBaseline: true,
        },
      ],
      currentBalanceMinor: 90_000_00,
      debtModel: "amortizable",
    });
  });

  test("a revolving or informal debt carries its declared balances", () => {
    expect(
      debtBalanceCurveInput({
        ...NO_ROWS,
        anchors: [ANCHOR_ROW],
        cadence: "step",
        currentBalanceMinor: 3_000_00,
        debtModel: "revolving",
      }),
    ).toEqual({
      anchors: [{ anchorDate: "2026-07-01", balanceMinor: 1_200_00 }],
      cadence: "step",
      currentBalanceMinor: 3_000_00,
      debtModel: "revolving",
    });
  });
});

async function seed(): Promise<{ client: Client; store: PersistenceTestStore }> {
  const client = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jose" }],
    mode: "individual",
  });
  for (const id of ["l_plan", "l_rebased", "l_card", "l_bare"]) {
    await store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id,
      name: id,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "debt",
    });
  }
  await store.liabilities.setDebtModel("l_plan", "amortizable");
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-15",
    firstPaymentDate: "2020-03-01",
    id: "plan_1",
    initialCapitalMinor: 200_000_00,
    liabilityId: "l_plan",
    termMonths: 240,
  });
  await store.liabilities.addInterestRateRevision({
    id: "rev_1",
    newAnnualInterestRate: "0.04",
    planId: "plan_1",
    revisionDate: "2022-01-01",
  });
  await store.liabilities.setDebtModel("l_rebased", "amortizable");
  await store.liabilities.addBalanceRebaseline({
    ...REBASELINE_ROW,
    liabilityId: "l_rebased",
  });
  await store.liabilities.setDebtModel("l_card", "revolving");
  await store.liabilities.setValuationCadence("l_card", "interpolated");
  await store.liabilities.addBalanceAnchor({
    anchorDate: "2026-07-01",
    balanceMinor: 1_200_00,
    id: "anchor_1",
    liabilityId: "l_card",
  });
  return { client, store };
}

describe("readDebtBalanceInputs — the board's batch read, through the same function (#1848)", () => {
  test("hands out exactly the curve inputs it handed out before", async () => {
    const { client, store } = await seed();
    const inputs = await readDebtBalanceInputs(
      openDrizzle(client),
      await store.liabilities.readLiabilities(),
    );

    // The shapes the board's read built inline before the extraction, literal. The
    // bare debt has no model, so no entry: its stored balance stays its figure.
    expect(Object.fromEntries(inputs)).toEqual({
      l_card: {
        anchors: [{ anchorDate: "2026-07-01", balanceMinor: 1_200_00 }],
        cadence: "interpolated",
        currentBalanceMinor: 100_000_00,
        debtModel: "revolving",
      },
      l_plan: {
        balanceRebaselines: [],
        currentBalanceMinor: 100_000_00,
        debtModel: "amortizable",
        earlyRepayments: [],
        plan: {
          annualInterestRate: "0.03",
          disbursementDate: "2020-01-15",
          firstPaymentDate: "2020-03-01",
          initialCapitalMinor: 200_000_00,
          termMonths: 240,
        },
        revisions: [{ newAnnualInterestRate: "0.04", revisionDate: "2022-01-01" }],
      },
      l_rebased: {
        balanceRebaselines: [
          {
            annualInterestRate: "0.0325",
            baselineDate: "2026-01-01",
            endDate: "2030-01-01",
            nextPaymentDate: "2026-02-01",
            outstandingBalanceMinor: 90_000_00,
            startsAtBaseline: true,
          },
        ],
        currentBalanceMinor: 100_000_00,
        debtModel: "amortizable",
      },
    });
  });
});
