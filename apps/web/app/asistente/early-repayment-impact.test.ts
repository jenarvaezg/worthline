import { describe, expect, test } from "vitest";

import {
  type EarlyRepaymentImpactInput,
  projectEarlyRepaymentImpact,
} from "./early-repayment-impact";

/**
 * A 12 000 € / 24-month / 6 % loan, cuotas on the 15th. Small enough that the
 * arithmetic below can be checked by hand, long enough that a `reduce-term` lump
 * visibly shortens it.
 */
const PLAN = {
  annualInterestRate: "0.06",
  disbursementDate: "2026-01-15",
  firstPaymentDate: "2026-02-15",
  initialCapitalMinor: 12_000_00,
  termMonths: 24,
} as const;

function input(
  overrides: Partial<EarlyRepaymentImpactInput> = {},
): EarlyRepaymentImpactInput {
  return {
    plan: PLAN,
    revisions: [],
    existing: [],
    balanceRebaselines: [],
    cadence: null,
    currentBalanceMinor: 10_000_00,
    today: "2026-07-26",
    proposed: {
      amountMinor: 1_000_00,
      mode: "reduce-term",
      repaymentDate: "2026-07-20",
    },
    ...overrides,
  };
}

describe("early-repayment impact (#1245)", () => {
  test("names the cuota the lump falls in, not only the date the user believes", () => {
    // 2026-07-20 is five days after the July cuota, so the balance drops on the
    // 20th (#1291) while the cuota recomputed with the reduced balance is the
    // 2026-07-15 one. The preview must say so instead of leaving the user to guess
    // which of the two dates moved what.
    const impact = projectEarlyRepaymentImpact(input());

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.boundaryDate).toBe("2026-07-15");
    expect(impact.boundaryIsRepaymentDate).toBe(false);
    expect(impact.notes.join(" ")).toMatch(/15\/07\/2026/);
  });

  test("reports the domain's own before/after balances on the repayment date", () => {
    const impact = projectEarlyRepaymentImpact(input());

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    // The lump is exactly 1 000 € off the balance of its own day (#1291) — the
    // engine's figure, not a re-derivation here.
    expect(impact.balanceBeforeMinor - impact.balanceAfterMinor).toBe(1_000_00);
    expect(impact.balanceBeforeMinor).toBeGreaterThan(0);
  });

  test("reduce-term keeps the cuota and pulls the end date in", () => {
    const impact = projectEarlyRepaymentImpact(input());

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.monthlyPaymentAfterMinor).toBe(impact.monthlyPaymentBeforeMinor);
    expect(impact.endDateAfter < impact.endDateBefore).toBe(true);
  });

  test("reduce-payment keeps the end date and lowers the cuota", () => {
    const impact = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-payment",
          repaymentDate: "2026-07-15",
        },
      }),
    );

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.monthlyPaymentAfterMinor).toBeLessThan(
      impact.monthlyPaymentBeforeMinor,
    );
    expect(impact.endDateAfter).toBe(impact.endDateBefore);
    expect(impact.boundaryIsRepaymentDate).toBe(true);
  });

  test("a lump that covers the live balance is a total repayment, and the preview says so", () => {
    const base = projectEarlyRepaymentImpact(input());
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const impact = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: base.balanceBeforeMinor,
          mode: "reduce-term",
          repaymentDate: "2026-07-20",
        },
      }),
    );

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.balanceAfterMinor).toBe(0);
    expect(impact.fullyRepaid).toBe(true);
    expect(impact.notes.join(" ")).toMatch(/cancela/i);
  });

  test("refuses an amount past the live balance plus one cuota: that is a unit slip (#1266)", () => {
    // `913200` for 91,32 € is a well-formed integer the parser cannot catch. The
    // engine would clamp the principal at 0 and preview a credible cancellation,
    // so the ceiling has to live here, where the live balance is known.
    const impact = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: 999_999_00,
          mode: "reduce-term",
          repaymentDate: "2026-07-15",
        },
      }),
    );

    expect(impact.ok).toBe(false);
    if (impact.ok) return;
    expect(impact.error).toMatch(/supera el saldo vivo/i);
    expect(impact.error).toMatch(/céntimos/i);
  });

  test("still accepts the room a real cancellation needs: balance plus one cuota", () => {
    const base = projectEarlyRepaymentImpact(input());
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const payoff = (extraMinor: number) =>
      projectEarlyRepaymentImpact(
        input({
          proposed: {
            amountMinor: base.balanceBeforeMinor + extraMinor,
            mode: "reduce-term",
            repaymentDate: "2026-07-20",
          },
        }),
      );

    // Principal + accrued interest + a cancellation fee fits; one cent past the
    // allowance does not, so the boundary is exact and not a soft warning.
    expect(payoff(base.monthlyPaymentBeforeMinor).ok).toBe(true);
    expect(payoff(base.monthlyPaymentBeforeMinor + 1).ok).toBe(false);
  });

  test("reconciles the observed cuota against the plan's and flags a mismatch", () => {
    const matching = projectEarlyRepaymentImpact(input());
    expect(matching.ok).toBe(true);
    if (!matching.ok) return;

    const reconciled = projectEarlyRepaymentImpact(
      input({ observedMonthlyPaymentMinor: matching.monthlyPaymentAfterMinor }),
    );
    const mismatched = projectEarlyRepaymentImpact(
      input({ observedMonthlyPaymentMinor: matching.monthlyPaymentAfterMinor + 5_00 }),
    );

    expect(reconciled.ok && reconciled.reconciliation).toMatchObject({ matches: true });
    expect(mismatched.ok && mismatched.reconciliation).toMatchObject({ matches: false });
    // A mismatch warns; it never silently applies the plan's own figure.
    expect(mismatched.ok && mismatched.notes.join(" ")).toMatch(/cuota/i);
  });

  test("reconciles against the cuota that will be in force, not the previous one", () => {
    // A `reduce-payment` lump lowers the cuota, so the two figures differ and the
    // comparison has to pick the RESULTING one — the number the bank screen shows
    // as the next payment.
    const base = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-payment",
          repaymentDate: "2026-07-15",
        },
      }),
    );
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(base.monthlyPaymentAfterMinor).not.toBe(base.monthlyPaymentBeforeMinor);

    const againstOld = projectEarlyRepaymentImpact(
      input({
        observedMonthlyPaymentMinor: base.monthlyPaymentBeforeMinor,
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-payment",
          repaymentDate: "2026-07-15",
        },
      }),
    );
    const againstNew = projectEarlyRepaymentImpact(
      input({
        observedMonthlyPaymentMinor: base.monthlyPaymentAfterMinor,
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-payment",
          repaymentDate: "2026-07-15",
        },
      }),
    );

    expect(againstOld.ok && againstOld.reconciliation).toMatchObject({
      matches: false,
      planMonthlyPaymentMinor: base.monthlyPaymentAfterMinor,
    });
    expect(againstNew.ok && againstNew.reconciliation).toMatchObject({ matches: true });
  });

  test("refuses a repayment dated before the loan's first cuota", () => {
    const impact = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-term",
          repaymentDate: "2026-01-20",
        },
      }),
    );

    expect(impact.ok).toBe(false);
    if (impact.ok) return;
    expect(impact.error).toMatch(/primera cuota/i);
  });

  test("ignores repayments the effective schedule does not read", () => {
    // A lump before the active re-baseline is not applied by the engine after it
    // (ADR 0056), so it must not enter the before/after arithmetic either.
    const withStaleLump = projectEarlyRepaymentImpact(
      input({
        existing: [
          { amountMinor: 400_00, mode: "reduce-term", repaymentDate: "2026-05-15" },
        ],
        balanceRebaselines: [
          {
            annualInterestRate: "0.06",
            baselineDate: "2026-06-15",
            endDate: "2028-01-15",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 10_500_00,
            startsAtBaseline: false,
          },
        ],
      }),
    );
    const withoutIt = projectEarlyRepaymentImpact(
      input({
        balanceRebaselines: [
          {
            annualInterestRate: "0.06",
            baselineDate: "2026-06-15",
            endDate: "2028-01-15",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 10_500_00,
            startsAtBaseline: false,
          },
        ],
      }),
    );

    expect(withStaleLump.ok && withStaleLump.balanceBeforeMinor).toBe(
      withoutIt.ok && withoutIt.balanceBeforeMinor,
    );
  });

  test("says nothing about reconciliation when the capture shows no cuota", () => {
    const impact = projectEarlyRepaymentImpact(input());

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.reconciliation).toBeNull();
  });

  test("warns when a later re-baseline swallows the repayment's effect on today", () => {
    // ADR 0056: from 2026-08-01 the curve is derived from the re-baseline, so a
    // July lump changes nothing the user sees today. Saying otherwise would be a lie.
    const impact = projectEarlyRepaymentImpact(
      input({
        today: "2026-09-01",
        balanceRebaselines: [
          {
            annualInterestRate: "0.06",
            baselineDate: "2026-08-01",
            endDate: "2028-01-15",
            nextPaymentDate: "2026-08-15",
            outstandingBalanceMinor: 9_500_00,
            startsAtBaseline: false,
          },
        ],
      }),
    );

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.balanceTodayAfterMinor).toBe(impact.balanceTodayBeforeMinor);
    expect(impact.notes.join(" ")).toMatch(/saldo de hoy/i);
    // The cause is named only because it exists — with its date, so the user can
    // go and look at it.
    expect(impact.notes.join(" ")).toMatch(/recalibración posterior \(01\/08\/2026\)/);
  });

  test("never invents a re-baseline to explain a frozen figure (ADR 0048, #1266)", () => {
    // Same symptom, different cause: the loan was simply already paid off before
    // today. There is no re-baseline in the workspace, so the note must not claim
    // one — it says what actually happened.
    const impact = projectEarlyRepaymentImpact(
      input({
        today: "2028-06-01",
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-term",
          repaymentDate: "2027-06-20",
        },
      }),
    );

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.balanceTodayAfterMinor).toBe(impact.balanceTodayBeforeMinor);
    expect(impact.notes.join(" ")).not.toMatch(/recalibración/i);
    expect(impact.notes.join(" ")).toMatch(/liquidado antes de hoy/i);
  });

  test("refuses a repayment dated before the modelled window starts", () => {
    const impact = projectEarlyRepaymentImpact(
      input({
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-term",
          repaymentDate: "2026-03-15",
        },
        balanceRebaselines: [
          {
            annualInterestRate: "0.06",
            baselineDate: "2026-06-01",
            endDate: "2028-01-15",
            nextPaymentDate: "2026-06-15",
            outstandingBalanceMinor: 10_500_00,
            startsAtBaseline: true,
          },
        ],
      }),
    );

    expect(impact.ok).toBe(false);
    if (impact.ok) return;
    expect(impact.error).toMatch(/2026-06-01/);
  });

  test("refuses a repayment past the loan's final payment instead of dropping it", () => {
    const impact = projectEarlyRepaymentImpact(
      input({
        today: "2028-06-01",
        proposed: {
          amountMinor: 1_000_00,
          mode: "reduce-term",
          repaymentDate: "2028-05-15",
        },
      }),
    );

    expect(impact.ok).toBe(false);
    if (impact.ok) return;
    expect(impact.error).toMatch(/última cuota|fuera del plazo/i);
  });

  test("notes a second lump in the same cuota, each dated on its own day", () => {
    const impact = projectEarlyRepaymentImpact(
      input({
        existing: [
          { amountMinor: 500_00, mode: "reduce-term", repaymentDate: "2026-07-16" },
        ],
      }),
    );

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.notes.join(" ")).toMatch(/16\/07\/2026/);
    // The earlier lump (16-jul) is already in the balance of the 20th, so the pair
    // moves by THIS lump alone — never by the sum, never silently.
    expect(impact.balanceBeforeMinor - impact.balanceAfterMinor).toBe(1_000_00);
    const alone = projectEarlyRepaymentImpact(input());
    expect(alone.ok).toBe(true);
    if (!alone.ok) return;
    expect(alone.balanceBeforeMinor - impact.balanceBeforeMinor).toBe(500_00);
  });
});
