/**
 * The assumptions behind the FIRE projection, in words (#1426).
 *
 * The three scenario cards (8 / 11 / 18 años) were a black box: nothing on screen
 * said why 8, why 11, why 18 — and a figure whose inputs are invisible reads as a
 * constant of physics rather than as arithmetic over the user's own numbers. Every
 * input already travels to the page; this module is where they get printed.
 *
 * Pure and label-only (interaction-patterns §7, ADR 0036): the figures come from
 * the engine — `fireReturnMix` for the weights, the projection's own scenarios for
 * the shifted rates — so the fold can never quote a rate the chart did not use.
 */

import type {
  FireAgeSource,
  FireProjection,
  FireReturnMix,
  FireScopeConfig,
  ScopeFireResult,
} from "@worthline/domain";
import { isManualFireReturn, monthlySavingsCapacityForFire } from "@worthline/domain";
import {
  formatFineFirePercent,
  formatRatePercent,
  formatRatePoints,
} from "./fire-percent";
import { fireAgeProvenance } from "./fire-provenance";

/** One printed line of the assumptions fold: what it is, its value, where it comes from. */
export interface FireAssumptionRow {
  key: string;
  label: string;
  value: string;
  /** Provenance or definition — never a restatement of the value. */
  gloss?: string;
}

/** One printed row of the weighted-return table. */
export interface FireReturnMixPrintRow {
  key: string;
  label: string;
  /** This slice's share of the eligible pool: `26,6 %`. */
  weight: string;
  /** The real return applied to it: `5,0 %`. */
  rate: string;
  /** What it lends to the total: `1,33 %`. */
  contribution: string;
  /**
   * True when the row is one asset's own rate standing in for its rung's guess
   * (#1448) — the caller marks it, because "Piso de Plasencia" beside "Vivienda"
   * needs to read as a subdivision, not as a second rung.
   */
  isAsset: boolean;
}

export interface FireAssumptionRowsInput {
  result: ScopeFireResult;
  config: FireScopeConfig;
  /** The projection actually rendered; its scenarios carry the shifted rates. */
  projection: FireProjection | null;
  /** Where the current age came from (#1415), when it was derived at all. */
  ageSource: FireAgeSource | null;
  /** Money formatter from the page (privacy mode included). */
  formatMoney: (amountMinor: number) => string;
}

/**
 * The rows of «Supuestos de esta proyección», in the order a reader rebuilds the
 * chain: what you spend → what you withdraw → the target → what you add → what it
 * grows at → the ages the years are counted between.
 */
export function fireAssumptionRows(input: FireAssumptionRowsInput): FireAssumptionRow[] {
  const { ageSource, config, formatMoney, projection, result } = input;
  const annualSpendingMinor = config.monthlySpendingMinor * 12;
  const savingsMinor = monthlySavingsCapacityForFire(config);
  const rateIsManual = isManualFireReturn(config);

  const rows: FireAssumptionRow[] = [
    {
      gloss: `${formatMoney(config.monthlySpendingMinor)}/mes, el gasto que declaras`,
      key: "spending",
      label: "Objetivo de gasto",
      value: `${formatMoney(annualSpendingMinor)}/año`,
    },
    {
      gloss: "la parte de tu capital que retiras cada año",
      key: "swr",
      label: "Tasa de retirada",
      value: formatRatePercent(config.safeWithdrawalRate),
    },
    {
      gloss: `${formatMoney(annualSpendingMinor)} ÷ ${formatRatePercent(
        config.safeWithdrawalRate,
      )}`,
      key: "fireNumber",
      label: "Número FIRE",
      value: formatMoney(result.fireNumber.amountMinor),
    },
    {
      gloss: "tu capacidad de ahorro declarada: la proyección usa exactamente esta cifra",
      key: "savings",
      label: "Aportación",
      value: `${formatMoney(savingsMinor)}/mes`,
    },
    {
      // Con el inmovilizado declarado fuera (#1460) la tabla de debajo no tiene fila de
      // vivienda: la mezcla que pondera es la vendible, y decirlo aquí evita que la
      // ausencia se lea como un tramo que la app se olvidó de contar.
      gloss: rateIsManual
        ? "fijada a mano en tus supuestos: sustituye a la ponderación de tu mezcla"
        : result.capitalSplit.countsImmobilized
          ? "ponderada por tu mezcla de activos — el desglose está debajo"
          : "ponderada por tu mezcla vendible: has declarado que el inmovilizado no cuenta — el desglose está debajo",
      key: "return-base",
      label: "Rentabilidad real (base)",
      value: formatRatePercent(result.context.realReturnUsed),
    },
  ];

  // The shifted rates AND the size of their shift are read off the scenarios that were
  // actually projected: «la base más 1,5 puntos» as fixed copy would keep claiming a
  // shift the engine could stop applying, next to a value that had already moved.
  const baseScenario = projection?.scenarios.find((item) => item.label === "base");
  const scenarioRow = (
    label: "optimistic" | "pessimistic",
    rowLabel: string,
    direction: "más" | "menos",
  ): FireAssumptionRow | null => {
    const scenario = projection?.scenarios.find((item) => item.label === label);
    if (scenario === undefined) {
      return null;
    }
    const shift =
      baseScenario === undefined
        ? null
        : Math.abs(scenario.annualReturn - baseScenario.annualReturn);

    return {
      key: `return-${label}`,
      label: rowLabel,
      value: formatRatePercent(scenario.annualReturn),
      ...(shift === null
        ? {}
        : { gloss: `la base ${direction} ${formatRatePoints(shift)}` }),
    };
  };

  const optimistic = scenarioRow("optimistic", "Rentabilidad optimista", "más");
  const pessimistic = scenarioRow("pessimistic", "Rentabilidad pesimista", "menos");
  if (optimistic) {
    rows.push(optimistic);
  }
  if (pessimistic) {
    rows.push(pessimistic);
  }

  const currentAge = config.currentAge;
  const targetAge = config.targetRetirementAge;
  if (currentAge !== undefined || targetAge !== undefined) {
    // Tres estados, no dos: sin `ageSource` la edad puede venir de una config
    // antigua o no existir en absoluto, y decirle «la tienes a mano» a quien no
    // tiene ninguna lo manda a buscar un campo que ya no existe (#1450).
    const provenance = fireAgeProvenance(ageSource, config);
    const gloss =
      provenance.kind === "derived"
        ? `tu edad sale de tu año de nacimiento (${provenance.birthYear}): no se teclea y no caduca`
        : provenance.kind === "frozen"
          ? "la edad actual viene de una configuración antigua: añade tu fecha de nacimiento en Ajustes → Miembros"
          : "sin fecha de nacimiento no hay edad actual: añádela en Ajustes → Miembros";

    rows.push({
      gloss,
      key: "ages",
      label: "Edad actual / objetivo",
      value: `${currentAge ?? "—"} / ${targetAge ?? "—"}`,
    });
  }

  return rows;
}

/**
 * The weighted-return table: one row per slice of the eligible pool, so «3,50 %»
 * becomes «26,6 % en mercado al 5 % → 1,33 %» and the reader sees that the brick
 * governs the rate. Empty when the mix has nothing to explain.
 */
export function fireReturnMixPrintRows(mix: FireReturnMix): FireReturnMixPrintRow[] {
  return mix.rows.map((row) => ({
    contribution: formatFineFirePercent(row.contribution),
    isAsset: row.kind === "asset",
    key: row.key,
    label: row.label,
    rate: formatRatePercent(row.rate),
    weight: formatFineFirePercent(row.weightFraction),
  }));
}

/**
 * The table's total line. `weight` is the sum of the printed weights (100 %) and
 * `contribution` the rate they add up to — the same scalar the «Rentabilidad real
 * (base)» row prints, since both come from `fireReturnMix`.
 */
export function fireReturnMixTotal(mix: FireReturnMix): {
  weight: string;
  contribution: string;
} {
  return {
    contribution: formatFineFirePercent(mix.rate),
    weight: formatFineFirePercent(
      mix.rows.reduce((sum, row) => sum + row.weightFraction, 0),
    ),
  };
}
