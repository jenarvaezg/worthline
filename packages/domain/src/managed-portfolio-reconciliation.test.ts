import { describe, expect, it } from "vitest";

import {
  describeManagedPortfolioDrift,
  formatDriftBps,
  MANAGED_PORTFOLIO_DRIFT_THRESHOLD_BPS,
  type ManagedPortfolioMemberValue,
  reconcileManagedPortfolio,
} from "./managed-portfolio-reconciliation";

/** A member holding `amountMinor` in EUR; `null` means "no honest value". */
function member(
  holdingId: string,
  amountMinor: number | null,
  options: { isCash?: boolean; currency?: string } = {},
): ManagedPortfolioMemberValue {
  return {
    holdingId,
    isCash: options.isCash ?? false,
    value:
      amountMinor === null ? null : { amountMinor, currency: options.currency ?? "EUR" },
  };
}

/**
 * The real Metal of the acceptance criteria (#1550): the seven funds worth
 * 1.479,26 € on 23-08 against the 1.497,37 € read in MyInvestor on 21-08, with
 * 7,34 € sitting in the container's cash box.
 */
const METAL_FUNDS_MINOR = 147_926;
const METAL_DECLARED_MINOR = 149_737;

function metalMembers(cashMinor: number): ManagedPortfolioMemberValue[] {
  return [member("fund", METAL_FUNDS_MINOR), member("cash", cashMinor, { isCash: true })];
}

describe("reconcileManagedPortfolio", () => {
  it("does not compare anything without a witness", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(734),
      witness: null,
    });

    expect(result.state).toBe("no_witness");
    expect(result.driftBps).toBeNull();
    expect(result.investmentValue.amountMinor).toBe(METAL_FUNDS_MINOR);
    expect(result.cashValue.amountMinor).toBe(734);
  });

  it("careas the witness against the FUNDS: the real Metal is aligned at −1,21 %", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(734),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "EUR" },
      },
    });

    expect(result.state).toBe("aligned");
    expect(result.driftBps).toBe(-121);
    expect(formatDriftBps(result.driftBps!)).toBe("−1,2 %");
  });

  it("stays silent with the cash box FULL — the regression of #1550's correction", () => {
    // 150 € + 0,5 % × 1.497,37 = 157,49 € waiting to be invested: more than ten
    // points of drift if the cash entered the careo. It does not.
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(15_749),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "EUR" },
      },
    });

    expect(result.state).toBe("aligned");
    expect(result.driftBps).toBe(-121);
    expect(result.cashValue.amountMinor).toBe(15_749);
    // Had the cash been careed, the drift would have been ~+9,3 %.
    expect(result.investmentValue.amountMinor).toBe(METAL_FUNDS_MINOR);
  });

  it("diverges when the witness sits 5 % away from the funds", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(734),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: {
          amountMinor: Math.round(METAL_FUNDS_MINOR / 0.95),
          currency: "EUR",
        },
      },
    });

    expect(result.state).toBe("diverged");
    expect(result.driftBps).toBe(-500);
  });

  it("treats the threshold as strictly 'beyond': exactly 2 % is still aligned", () => {
    const declaredMinor = 100_000;
    const atThreshold = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: [member("fund", 102_000)],
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: declaredMinor, currency: "EUR" },
      },
    });
    const pastThreshold = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: [member("fund", 102_001)],
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: declaredMinor, currency: "EUR" },
      },
    });

    expect(MANAGED_PORTFOLIO_DRIFT_THRESHOLD_BPS).toBe(200);
    expect(atThreshold.state).toBe("aligned");
    expect(pastThreshold.state).toBe("diverged");
  });

  it("refuses to careo a witness declared in another currency", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(734),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "USD" },
      },
    });

    expect(result.state).toBe("not_comparable");
    expect(result.reason).toBe("currency_mismatch");
    expect(result.driftBps).toBeNull();
  });

  it("refuses to careo an INCOMPLETE derived side (a member with no honest value)", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: [
        member("fund", METAL_FUNDS_MINOR),
        member("foreign", 10_000, { currency: "USD" }),
        member("cash", 734, { isCash: true }),
      ],
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "EUR" },
      },
    });

    expect(result.state).toBe("not_comparable");
    expect(result.reason).toBe("incomplete_members");
    // The dollar member never joined the euro sum (#1401).
    expect(result.investmentValue.amountMinor).toBe(METAL_FUNDS_MINOR);
  });

  it("has nothing to compare when only the cash box is a member", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: [member("cash", 15_749, { isCash: true })],
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "EUR" },
      },
    });

    expect(result.state).toBe("not_comparable");
    expect(result.reason).toBe("no_investment_value");
  });

  it("reports the cash even when it cannot be converted, without blocking the careo", () => {
    const result = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: [
        member("fund", METAL_FUNDS_MINOR),
        member("cash", 10_000, { currency: "USD", isCash: true }),
      ],
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: METAL_DECLARED_MINOR, currency: "EUR" },
      },
    });

    expect(result.state).toBe("aligned");
    expect(result.cashValue.amountMinor).toBe(0);
  });
});

describe("describeManagedPortfolioDrift", () => {
  it("names the portfolio, both figures, the drift and the cash left out", () => {
    const reconciliation = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(15_749),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: 158_000, currency: "EUR" },
      },
    });

    const label = describeManagedPortfolioDrift({
      portfolioName: "Cartera Indexada Metal",
      reconciliation,
    });

    expect(reconciliation.state).toBe("diverged");
    expect(label).toContain("Cartera Indexada Metal");
    expect(label).toContain("2026-08-21");
    expect(label).toContain("−6,4 %");
    expect(label).toContain("efectivo");
  });

  it("hides the figures in privacy mode", () => {
    const reconciliation = reconcileManagedPortfolio({
      baseCurrency: "EUR",
      members: metalMembers(734),
      witness: {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: 200_000, currency: "EUR" },
      },
    });

    const label = describeManagedPortfolioDrift({
      portfolioName: "Metal",
      privacyMode: true,
      reconciliation,
    });

    expect(label).not.toContain("1.479");
    expect(label).not.toContain("2.000");
  });
});
