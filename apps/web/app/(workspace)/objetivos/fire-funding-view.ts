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

import type { FireScopeConfig, ScopeFireResult } from "@worthline/domain";
import { formatFirePercent, formatRatePercent } from "./fire-percent";

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

/**
 * The Coast requirement with the compound check behind it — the one link of the chain
 * «número FIRE → capital elegible → % → retorno ponderado → coast → escenarios» that
 * was still a bare figure. Null when there is no coast requirement, or when the years
 * to the target age cannot be read off the config.
 */
export function coastFormulaLine(input: {
  result: ScopeFireResult;
  config: FireScopeConfig;
  formatMoney: (amountMinor: number) => string;
}): string | null {
  const { config, formatMoney, result } = input;
  const coastRequired = result.coastFireRequired;
  const currentAge = config.currentAge;

  if (coastRequired === undefined || currentAge === undefined) {
    return null;
  }

  // The same horizon `calculateFire` compounds over: target age (65 by default) minus
  // the derived current age. Reading it off the config here keeps the sentence true
  // when the user moves either age.
  const years = (config.targetRetirementAge ?? 65) - currentAge;
  const rate = formatRatePercent(result.context.realReturnUsed);
  const yearsLabel = years === 1 ? "1 año" : `${years} años`;

  // Said in words, not in notation: «÷ (1 + r)^n» is the formula, but a reader checking
  // his own figure needs the sentence — the number, the horizon and the rate it was
  // discounted at.
  return `tu número FIRE descontado ${yearsLabel} al ${rate}: ${formatMoney(
    result.fireNumber.amountMinor,
  )} → ${formatMoney(coastRequired.amountMinor)}`;
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
    percent: formatFirePercent(result.percentFunded),
  };
}
