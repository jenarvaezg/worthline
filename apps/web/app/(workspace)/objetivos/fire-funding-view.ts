/**
 * The two progress questions the FIRE panel answers (#1426).
 *
 * A big lone percentage reads as a probability — «tengo un 68,5 % de posibilidades
 * de llegar» — so the figure needs a noun and the fraction it came from. And the
 * bar's tick used to describe itself («el 84,2 % de tu número FIRE»), which is a
 * property of the tick, not of the reader's progress. The actionable pair is:
 *
 * - «llevo el 68,5 % de FIRE» → how far from living off this
 * - «llevo el ~81 % de Coast» → how far from being able to stop contributing
 *
 * Both are true and they answer different questions, so both are printed. Pure:
 * the amounts come from `calculateFireForScope`, this module only divides and
 * words them (interaction-patterns §7).
 */

import type { ScopeFireResult } from "@worthline/domain";

const oneDecimal = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/** A progress percentage as es-ES text: `68,5 %`. */
export function formatProgressPercent(percent: number): string {
  return `${oneDecimal.format(percent)} %`;
}

/**
 * Progress toward the Coast requirement, as a percentage — «cuánto me falta para
 * poder dejar de aportar». Null when there is no coast requirement to measure
 * against (no age configured, or a rate that cannot compound).
 */
export function coastProgressPercent(
  eligibleMinor: number,
  coastRequiredMinor: number | null | undefined,
): number | null {
  if (coastRequiredMinor == null || coastRequiredMinor <= 0) {
    return null;
  }
  return (eligibleMinor / coastRequiredMinor) * 100;
}

/** The hero's funded figure with the noun and the division behind it. */
export interface FireFundedView {
  /** `68,5 %` — the percentage on its own, for the hero figure. */
  percent: string;
  /** `469.671 € de 685.714 €` — the fraction the percentage came from. */
  fraction: string;
}

export function fireFundedView(input: {
  result: ScopeFireResult;
  formatMoney: (amountMinor: number) => string;
}): FireFundedView {
  const { formatMoney, result } = input;

  return {
    fraction: `${formatMoney(result.eligibleAssets.amountMinor)} de ${formatMoney(
      result.fireNumber.amountMinor,
    )}`,
    percent: formatProgressPercent(result.percentFunded),
  };
}
