import { describe, expect, test } from "vitest";

import { type AmortizationPlanInput, amortizableBalanceAtDate } from "./amortization";
import type { AmortizationScheduleReading } from "./amortization-schedule-adapter";
import {
  type AmortizationScheduleImportContext,
  buildAmortizationScheduleImportPlan,
} from "./amortization-schedule-import";

/**
 * The scenario is Jorge's mortgage, trimmed to the years that make each point
 * (#1406): 173.153,18 € at 360 months, signed 19-may-2004, first cuota 1-jul-2004,
 * revised every 1st of May.
 */
const PLAN: AmortizationPlanInput = {
  annualInterestRate: "0.027",
  disbursementDate: "2004-05-19",
  firstPaymentDate: "2004-07-01",
  initialCapitalMinor: 17_315_318,
  termMonths: 360,
};

function reading(
  overrides: Partial<AmortizationScheduleReading> = {},
): AmortizationScheduleReading {
  return {
    declaredBalances: [],
    earlyRepayments: [],
    rateScaleAmbiguous: false,
    revisions: [],
    sheetName: "Cuadro",
    warnings: [],
    ...overrides,
  };
}

function context(
  overrides: Partial<AmortizationScheduleImportContext> = {},
): AmortizationScheduleImportContext {
  return {
    balanceRebaselines: [],
    currentBalanceMinor: 5_335_017,
    existingEarlyRepayments: [],
    existingRevisions: [],
    plan: PLAN,
    ...overrides,
  };
}

/**
 * The balance the engine itself puts on a date — i.e. a truthful document. The
 * revisions come in the READING's shape so a test can hand the same array to the
 * document and to the engine without the two drifting apart.
 */
function curveAt(
  targetDate: string,
  revisions: { revisionDate: string; annualInterestRate: string }[],
  earlyRepayments: {
    repaymentDate: string;
    amountMinor: number;
    mode: "reduce-payment" | "reduce-term";
  }[] = [],
  plan: AmortizationPlanInput = PLAN,
): number {
  return amortizableBalanceAtDate({
    earlyRepayments,
    plan,
    revisions: revisions.map(({ annualInterestRate, revisionDate }) => ({
      newAnnualInterestRate: annualInterestRate,
      revisionDate,
    })),
    targetDate,
  });
}

describe("buildAmortizationScheduleImportPlan — what would be written", () => {
  test("a revision the plan does not have is new, and one it has is a duplicate", () => {
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        revisions: [
          { annualInterestRate: "0.02815", revisionDate: "2005-05-01" },
          { annualInterestRate: "0.03771", revisionDate: "2006-05-01" },
        ],
      }),
      context({
        existingRevisions: [
          { newAnnualInterestRate: "0.02815", revisionDate: "2005-05-01" },
        ],
      }),
    );

    expect(plan.revisions.map((revision) => revision.status)).toEqual([
      "duplicate",
      "new",
    ]);
    expect(plan.summary.newRevisionCount).toBe(1);
    expect(plan.summary.duplicateRevisionCount).toBe(1);
  });

  test("a duplicate that disagrees with the stored rate says what is stored", () => {
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        revisions: [{ annualInterestRate: "0.02815", revisionDate: "2005-05-01" }],
      }),
      context({
        existingRevisions: [
          { newAnnualInterestRate: "0.033", revisionDate: "2005-05-01" },
        ],
      }),
    );

    expect(plan.revisions[0]?.existingAnnualInterestRate).toBe("0.033");
  });

  test("an event past the final cuota is refused, never silently dropped", () => {
    // The plan's last boundary is 2034-06-01; the engine would never read an event
    // after it (#210), so the preview has to say so instead of writing it.
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        earlyRepayments: [{ amountMinor: 100_000, repaymentDate: "2040-01-01" }],
        revisions: [{ annualInterestRate: "0.03", revisionDate: "2040-01-01" }],
      }),
      context(),
    );

    expect(plan.revisions[0]?.status).toBe("outside-term");
    expect(plan.earlyRepayments[0]?.status).toBe("outside-term");
    expect(plan.summary.outsideTermCount).toBe(2);
    expect(plan.summary.rippleFromDateKey).toBeNull();
  });

  test("a lump defaults to reduce-payment and says so in the plan", () => {
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        earlyRepayments: [{ amountMinor: 350_000, repaymentDate: "2004-06-01" }],
      }),
      context(),
    );
    expect(plan.earlyRepayments[0]).toMatchObject({
      amountMinor: 350_000,
      mode: "reduce-payment",
      status: "new",
    });
  });

  test("the ripple floor is the earliest event's cuota boundary, not its date", () => {
    // 2005-05-15 sits inside the cycle that opened on 2005-05-01: the whole cycle
    // is redrawn, so that is the earliest date any figure can move (#1042).
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        revisions: [
          { annualInterestRate: "0.03", revisionDate: "2006-05-01" },
          { annualInterestRate: "0.028", revisionDate: "2005-05-15" },
        ],
      }),
      context(),
    );
    expect(plan.summary.rippleFromDateKey).toBe("2005-05-01");
  });
});

describe("buildAmortizationScheduleImportPlan — the document verifies itself", () => {
  const REVISIONS = [
    { annualInterestRate: "0.02815", revisionDate: "2005-05-01" },
    { annualInterestRate: "0.03771", revisionDate: "2006-05-01" },
  ];

  test("a curve that reproduces the declared balances agrees on every checkpoint", () => {
    const declaredBalances = ["2005-05-01", "2006-05-01", "2007-05-01"].map(
      (dateKey) => ({ balanceMinor: curveAt(dateKey, REVISIONS), dateKey }),
    );

    const plan = buildAmortizationScheduleImportPlan(
      reading({ declaredBalances, revisions: REVISIONS }),
      context(),
    );

    expect(plan.summary.checkedCount).toBe(3);
    expect(plan.summary.agreeingCount).toBe(3);
    expect(plan.summary.worstDrift).toBeNull();
    expect(plan.checkpoints.every((checkpoint) => checkpoint.governedBy === "plan")).toBe(
      true,
    );
  });

  test("a lump the document declares but the reading missed shows up as drift", () => {
    // Measured on the real file: dropping the 1.803,04 € lump of 2005 leaves the
    // curve ~1.800 € above the schedule for the next twenty years. That is exactly
    // the failure the checkpoints exist to catch before anything is written.
    const withLump = [
      {
        amountMinor: 180_304,
        mode: "reduce-payment" as const,
        repaymentDate: "2005-06-01",
      },
    ];
    const declaredBalances = ["2006-05-01", "2007-05-01"].map((dateKey) => ({
      balanceMinor: curveAt(dateKey, REVISIONS, withLump),
      dateKey,
    }));

    const plan = buildAmortizationScheduleImportPlan(
      reading({ declaredBalances, revisions: REVISIONS }),
      context(),
    );

    expect(plan.summary.agreeingCount).toBe(0);
    expect(plan.summary.worstDrift?.deltaMinor).toBeGreaterThan(150_000);
  });

  test("reading the same lump closes the gap", () => {
    const withLump = [
      {
        amountMinor: 180_304,
        mode: "reduce-payment" as const,
        repaymentDate: "2005-06-01",
      },
    ];
    const declaredBalances = ["2006-05-01", "2007-05-01"].map((dateKey) => ({
      balanceMinor: curveAt(dateKey, REVISIONS, withLump),
      dateKey,
    }));

    const plan = buildAmortizationScheduleImportPlan(
      reading({
        declaredBalances,
        earlyRepayments: [{ amountMinor: 180_304, repaymentDate: "2005-06-01" }],
        revisions: REVISIONS,
      }),
      context(),
    );

    expect(plan.summary.agreeingCount).toBe(2);
  });

  test("a checkpoint a re-baseline already covers says who governs it", () => {
    // The issue's open question, answered by ADR 0056's own precedence: from the
    // re-baseline forward the re-baseline governs, so the reconstruction fills only
    // the years it does not cover and retires nothing.
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        declaredBalances: [
          { balanceMinor: 15_543_899, dateKey: "2006-05-01" },
          { balanceMinor: 6_394_328, dateKey: "2024-05-01" },
        ],
        revisions: REVISIONS,
      }),
      context({
        balanceRebaselines: [
          {
            annualInterestRate: "0.04253",
            baselineDate: "2024-05-01",
            endDate: "2034-06-01",
            nextPaymentDate: "2024-06-01",
            outstandingBalanceMinor: 6_394_328,
          },
        ],
      }),
    );

    expect(plan.checkpoints.map((checkpoint) => checkpoint.governedBy)).toEqual([
      "plan",
      "rebaseline",
    ]);
    // The re-baselined checkpoint reproduces itself: that stretch is already true.
    expect(plan.checkpoints[1]?.agrees).toBe(true);
  });
});

describe("buildAmortizationScheduleImportPlan — settling an ambiguous rate scale", () => {
  const HALF_PERCENT_PLAN: AmortizationPlanInput = {
    ...PLAN,
    annualInterestRate: "0.005",
  };

  test("the reading the document's own balances reproduce is the one that wins", () => {
    // «0,5» with no percent sign: the fraction reading is a 50 % mortgage and the
    // percentage reading is half a point. Only the second reproduces the balances
    // the document prints, so only the second can be what the document meant.
    const truth = [{ annualInterestRate: "0.005", revisionDate: "2006-05-01" }];
    const declaredBalances = ["2006-05-01", "2010-05-01"].map((dateKey) => ({
      balanceMinor: curveAt(dateKey, truth, [], HALF_PERCENT_PLAN),
      dateKey,
    }));

    const plan = buildAmortizationScheduleImportPlan(
      reading({
        declaredBalances,
        rateScaleAmbiguous: true,
        revisions: [{ annualInterestRate: "0.5", revisionDate: "2006-05-01" }],
      }),
      context({ plan: HALF_PERCENT_PLAN }),
    );

    expect(plan.rateScaleAdjusted).toBe(true);
    expect(plan.revisions[0]?.newAnnualInterestRate).toBe("0.005");
    expect(plan.summary.agreeingCount).toBe(2);
    expect(plan.warnings.at(-1)).toContain("cien veces más pequeños");
  });

  test("an ambiguous document whose balances already fit keeps its first reading", () => {
    const truth = [{ annualInterestRate: "0.02815", revisionDate: "2005-05-01" }];
    const declaredBalances = ["2006-05-01"].map((dateKey) => ({
      balanceMinor: curveAt(dateKey, truth),
      dateKey,
    }));

    const plan = buildAmortizationScheduleImportPlan(
      reading({ declaredBalances, rateScaleAmbiguous: true, revisions: truth }),
      context(),
    );

    expect(plan.rateScaleAdjusted).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  test("with no balance to measure against, nothing is second-guessed", () => {
    const plan = buildAmortizationScheduleImportPlan(
      reading({
        rateScaleAmbiguous: true,
        revisions: [{ annualInterestRate: "0.5", revisionDate: "2006-05-01" }],
      }),
      context(),
    );
    expect(plan.rateScaleAdjusted).toBe(false);
  });
});
