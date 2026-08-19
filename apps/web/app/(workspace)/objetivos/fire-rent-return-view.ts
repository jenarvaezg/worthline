/**
 * Copy for the rent-derived FIRE return (#1448) — pure, so the panel renders and
 * never derives (interaction-patterns §7, ADR 0036).
 *
 * Two kinds of line, and both have to be sayable:
 *
 * - **applied**: this flat's declared net rent IS its expected real return, so its
 *   rung's guess did not apply to it. The line names the yield and the two figures
 *   behind it, because a rate nobody can audit is a rate nobody should trust.
 * - **withheld**: there is a declared rent and the rate did NOT use it. That is the
 *   guard the issue asks for — never promote a gross yield in silence. The line
 *   says what is missing, what the gross WOULD have been, and where to fix it.
 *
 * The tier fallback is never quoted as a number here: `tierRealReturns` can
 * override it per config, and a hardcoded "3 %" would be a sentence the app cannot
 * keep. The rate itself is printed once, by the panel, from the context.
 */

import type { FireRentReturnReport, RentReturnNotice } from "@worthline/domain";
import { formatRatePercent } from "./fire-percent";

/** One printed line of the rent-return disclosure. */
export interface FireRentReturnLine {
  /** The asset id, which is also the React key. */
  key: string;
  kind: "applied" | "withheld";
  /** "Piso Navalcarnero · 4,2 % real" — the headline of the line. */
  title: string;
  /** The audit trail in words, below the title. */
  gloss: string;
}

export interface FireRentReturnCopyInput {
  /**
   * Solo las dos listas: la renta neta agregada del informe es un INGRESO (#1428) y se
   * dice en la tarjeta de gasto sostenible, no en esta sección, que habla de la tasa.
   */
  report: Pick<FireRentReturnReport, "applied" | "notices">;
  /** Money formatter from the page (privacy mode included). */
  formatMoney: (amountMinor: number) => string;
}

/**
 * The lines to print, applied first. Empty when there is nothing to say — a
 * portfolio with no declared rent has no disclosure to make.
 */
export function fireRentReturnLines(
  input: FireRentReturnCopyInput,
): FireRentReturnLine[] {
  const { formatMoney, report } = input;

  const applied = report.applied.map((entry): FireRentReturnLine => {
    const yearly = `${formatMoney(entry.annualNetRentMinor)}/año netos sobre ${formatMoney(
      entry.valueMinor,
    )}`;
    const body = entry.isNetNegative
      ? `${yearly}: los gastos declarados superan al alquiler, así que su rendimiento real es negativo.`
      : `${yearly} (${formatMoney(entry.annualGrossRentMinor)} de alquiler − ${formatMoney(
          entry.annualExpensesMinor,
        )} de gastos).`;
    // A co-owned flat declares its rent and its value for 100 % of the property, so
    // the percentage is the same whatever the share — but the euros on this line are
    // not the euros the FIRE total counted, and saying so is cheaper than letting
    // the reader find the discrepancy himself.
    const share =
      entry.scopedValueMinor === entry.valueMinor
        ? ""
        : ` Cifras del 100 % del inmueble; en este ámbito pesa ${formatMoney(
            entry.scopedValueMinor,
          )}.`;
    return {
      gloss: `${body}${share}`,
      key: entry.assetId,
      kind: "applied",
      title: `${entry.assetName} · ${formatRatePercent(entry.rate)} real`,
    };
  });

  const withheld = report.notices.map(
    (notice): FireRentReturnLine => ({
      gloss: noticeGloss(notice),
      key: notice.assetId,
      kind: "withheld",
      title: notice.assetName,
    }),
  );

  return [...applied, ...withheld];
}

function noticeGloss(notice: RentReturnNotice): string {
  switch (notice.reason) {
    case "missing_expenses":
      // The gross is named, and named as what it is NOT: seeing 6,3 % beside the
      // reason is what makes declaring the costs worth the trouble.
      return `Su alquiler declarado no se usa todavía: falta declarar sus gastos en «Cobros», en la ficha del inmueble. Cuenta con el retorno por defecto de su tramo${
        notice.grossRate === null
          ? ""
          : `, no con el ${formatRatePercent(notice.grossRate)} que daría el alquiler bruto`
      }.`;
    case "no_live_schedule":
      // "No está vigente hoy" covers both halves of the reason: un alquiler que
      // terminó y uno que aún no empieza. Decir «ya no está vigente» a un piso que
      // se alquila en octubre sería falso.
      return "Su alquiler declarado no está vigente hoy, así que no alimenta la rentabilidad esperada: cuenta con el retorno por defecto de su tramo.";
    case "foreign_currency":
      return "Está valorado en otra divisa y un cobro no lleva divisa propia, así que su alquiler no se usa para derivar la rentabilidad.";
    case "immobilized_not_counted":
      // Ni un fallo ni una invitación: es la consecuencia de lo que el usuario
      // declaró, así que la línea no le pide arreglar nada — le recuerda dónde se
      // cambia de opinión.
      return "Has declarado que tu patrimonio inmovilizado no cuenta como capital FIRE, así que su alquiler tampoco alimenta la rentabilidad esperada. Se cambia en «Tus supuestos».";
  }
}
