/**
 * The FIRE assumptions form, as data (#1450).
 *
 * The form moved from /ajustes to /objetivos so the assumptions are edited beside
 * the figures they govern — a move, never a copy: two synchronized forms would be
 * two sources of truth for the same scope config.
 *
 * Everything a field needs that is not markup lives here, pure and testable
 * (interaction-patterns §7): what each input preloads, and what the two read-only
 * rows say about where their value comes from. The age is derived from the member's
 * birth date (#1415, ADR 0073) and the rate is either the user's manual override or
 * the weighting of their own mix (#1448) — neither is typed into this form, so both
 * have to declare their provenance instead of looking like blanks nobody filled.
 */

import { formatDecimalAsPercentField } from "@web/intake-primitives";
import type {
  FireAgeSource,
  FireScopeConfig,
  MonthlySavingsSuggestion,
} from "@worthline/domain";
import { isManualFireReturn } from "@worthline/domain";
import { formatRatePercent } from "./fire-percent";
import { fireAgeProvenance } from "./fire-provenance";

/** What each editable input preloads. `undefined` = the field renders blank. */
export interface FireConfigFieldValues {
  monthlySpending?: string;
  /** Never blank: the parser applies 4 % to an empty form, so the form says 4 %. */
  safeWithdrawalRate: string;
  monthlySavingsCapacity?: string;
  /** Never blank, same reason: the engine's default is 65. */
  targetRetirementAge: string;
  expectedRealReturn?: string;
  tierReturns: {
    cash?: string;
    market?: string;
    "term-locked"?: string;
    illiquid?: string;
  };
  leanMultiplier?: string;
  fatMultiplier?: string;
  baristaIncome?: string;
}

/** A row the user reads instead of editing: its value, and where it comes from. */
export interface FireConfigReadout {
  value: string;
  gloss: string;
}

const majorFromMinor = (amountMinor: number): string => (amountMinor / 100).toString();

/**
 * Los cuatro tramos con retorno configurable: su clave, cómo se llaman en pantalla
 * y el retorno que el motor aplica cuando el campo va vacío. Una tabla y no cuatro
 * bloques clonados, porque los defectos se citan además en la glosa de debajo y
 * dos listas del mismo hecho se separan.
 */
export const FIRE_TIER_FIELDS = [
  { defaultPercent: "0", key: "cash", label: "caja" },
  { defaultPercent: "5", key: "market", label: "mercado" },
  { defaultPercent: "1.5", key: "term-locked", label: "a plazo" },
  { defaultPercent: "3", key: "illiquid", label: "ilíquido" },
] as const;

export function fireConfigFieldValues(
  config: FireScopeConfig | null | undefined,
): FireConfigFieldValues {
  const tiers = config?.tierRealReturns;
  const tierReturns: FireConfigFieldValues["tierReturns"] = {};
  for (const { key } of FIRE_TIER_FIELDS) {
    const rate = tiers?.[key];
    if (rate !== undefined) {
      tierReturns[key] = formatDecimalAsPercentField(rate);
    }
  }

  return {
    ...(config == null
      ? {}
      : { monthlySpending: majorFromMinor(config.monthlySpendingMinor) }),
    safeWithdrawalRate:
      config == null ? "4" : formatDecimalAsPercentField(config.safeWithdrawalRate),
    // Zero is a declaration («no ahorro ahora mismo»), not an absence (#1416).
    ...(config?.monthlySavingsCapacityMinor === undefined
      ? {}
      : {
          monthlySavingsCapacity: majorFromMinor(config.monthlySavingsCapacityMinor),
        }),
    targetRetirementAge: (config?.targetRetirementAge ?? 65).toString(),
    ...(config?.expectedRealReturn === undefined
      ? {}
      : { expectedRealReturn: formatDecimalAsPercentField(config.expectedRealReturn) }),
    tierReturns,
    ...(config?.leanMultiplier === undefined
      ? {}
      : { leanMultiplier: config.leanMultiplier.toString() }),
    ...(config?.fatMultiplier === undefined
      ? {}
      : { fatMultiplier: config.fatMultiplier.toString() }),
    ...(config?.baristaMonthlyIncomeMinor === undefined
      ? {}
      : { baristaIncome: majorFromMinor(config.baristaMonthlyIncomeMinor) }),
  };
}

/**
 * The current age, read-only with its provenance (#1415). Three states, because the
 * silence of the third one is what used to make the coast figures vanish from
 * /objetivos with no explanation.
 */
export function fireCurrentAgeReadout(input: {
  ageSource: FireAgeSource | null;
  config: FireScopeConfig | null | undefined;
}): FireConfigReadout {
  const provenance = fireAgeProvenance(input.ageSource, input.config);

  switch (provenance.kind) {
    case "derived":
      return {
        gloss: `Derivada de tu año de nacimiento (${provenance.birthYear}): no se teclea y no caduca.`,
        value: `${provenance.age} años`,
      };
    case "frozen":
      return {
        gloss:
          "Viene de una configuración antigua y no se actualiza sola. Añade tu fecha de nacimiento en Ajustes → Miembros para que se calcule cada año.",
        value: `${provenance.age} años`,
      };
    case "absent":
      return {
        gloss:
          "Sin fecha de nacimiento no hay edad actual, y sin edad no se calculan el coast FIRE ni las edades de la proyección. Rellénala en Ajustes → Miembros.",
        value: "—",
      };
  }
}

/**
 * The real return, read-only with its provenance: either the user fixed it by hand
 * in the fine print below, or it is the weighting of their own asset mix (#1448).
 */
export function fireReturnReadout(input: {
  config: FireScopeConfig | null | undefined;
  realReturnUsed: number | null;
}): FireConfigReadout {
  const { config, realReturnUsed } = input;
  const manual = config != null && isManualFireReturn(config);

  if (realReturnUsed === null) {
    return {
      gloss:
        "Crecimiento anual esperado, ya descontada la inflación — mueve las tres curvas de la proyección.",
      value: "—",
    };
  }

  return {
    gloss: manual
      ? "Crecimiento anual esperado, ya descontada la inflación. Al fijarlo a mano sustituyes la ponderación de tu mezcla; bórralo en los supuestos finos para volver a ella."
      : "Crecimiento anual esperado, ya descontada la inflación — mueve las tres curvas de la proyección. Sale de ponderar tus tramos; el desglose está en «¿De dónde salen estos años?».",
    value: `${formatRatePercent(realReturnUsed)} (${manual ? "fijado a mano" : "ponderado de tu mezcla"})`,
  };
}

/**
 * What the savings field shows while it is empty: the measured figure when the
 * ledger has one, and «0» otherwise — «no ahorro ahora mismo» es la lectura por
 * defecto de una capacidad sin declarar (ADR 0074).
 */
export function fireSavingsPlaceholder(suggestion: MonthlySavingsSuggestion): string {
  return suggestion.basis === "operations" ? majorFromMinor(suggestion.amountMinor) : "0";
}

/**
 * The history-based savings hint (#425), or null when the ledger cannot support one.
 * A hint, never a value: the projection uses only the declared scalar (#1416).
 */
export function fireSavingsSuggestionLine(
  suggestion: MonthlySavingsSuggestion,
  formatMoney: (amountMinor: number) => string,
): string | null {
  if (suggestion.basis !== "operations") {
    return null;
  }
  return `Sugerido por tu histórico: ${formatMoney(suggestion.amountMinor)}/mes`;
}
