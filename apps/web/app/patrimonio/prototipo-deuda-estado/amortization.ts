export const BASELINE_DATE = "2026-07-02";

export type RateSolveResult =
  | { kind: "ok"; annualRatePercent: number }
  | { kind: "payment-too-low"; minimumPayment: number }
  | { kind: "invalid" };

function parts(isoDate: string): { day: number; month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const parsed = {
    day: Number(day),
    month: Number(month),
    year: Number(year),
  };

  if (
    parsed.year < 1900 ||
    parsed.month < 1 ||
    parsed.month > 12 ||
    parsed.day < 1 ||
    parsed.day > 31
  ) {
    return null;
  }

  return parsed;
}

export function remainingMonthlyPayments(fromIso: string, toIso: string): number {
  const from = parts(fromIso);
  const to = parts(toIso);

  if (!from || !to) {
    return 0;
  }

  const monthDelta = (to.year - from.year) * 12 + (to.month - from.month);
  const roundedUpForPartialMonth = monthDelta + (to.day > from.day ? 1 : 0);

  return Math.max(0, roundedUpForPartialMonth);
}

function paymentForMonthlyRate(
  balance: number,
  monthlyRate: number,
  months: number,
): number {
  if (monthlyRate === 0) {
    return balance / months;
  }

  return (balance * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
}

export function monthlyPaymentFromAnnualRate(
  balance: number,
  annualRatePercent: number,
  months: number,
): number | null {
  if (balance <= 0 || annualRatePercent < 0 || months <= 0) {
    return null;
  }

  return paymentForMonthlyRate(balance, annualRatePercent / 100 / 12, months);
}

export function annualRateFromMonthlyPayment(
  balance: number,
  monthlyPayment: number,
  months: number,
): RateSolveResult {
  if (balance <= 0 || monthlyPayment <= 0 || months <= 0) {
    return { kind: "invalid" };
  }

  const minimumPayment = balance / months;

  if (monthlyPayment < minimumPayment - 0.005) {
    return { kind: "payment-too-low", minimumPayment };
  }

  if (Math.abs(monthlyPayment - minimumPayment) <= 0.005) {
    return { kind: "ok", annualRatePercent: 0 };
  }

  let low = 0;
  let high = 0.01;

  while (paymentForMonthlyRate(balance, high, months) < monthlyPayment && high < 1) {
    high *= 2;
  }

  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const payment = paymentForMonthlyRate(balance, mid, months);

    if (payment < monthlyPayment) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return { kind: "ok", annualRatePercent: ((low + high) / 2) * 12 * 100 };
}
