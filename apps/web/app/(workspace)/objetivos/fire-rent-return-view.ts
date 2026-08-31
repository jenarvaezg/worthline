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

import { holdingCobrosHref } from "@web/holding-route";
import type {
  FireRentReturnReport,
  RentReturnNotice,
  RentScheduleWindow,
} from "@worthline/domain";
import { formatRatePercent } from "./fire-percent";
import { formatDay } from "./format-day";

/** One printed line of the rent-return disclosure. */
export interface FireRentReturnLine {
  /** The asset id, which is also the React key. */
  key: string;
  kind: "applied" | "withheld";
  /** "Piso Navalcarnero · 4,2 % real" — the headline of the line. */
  title: string;
  /** The audit trail in words, below the title. */
  gloss: string;
  /**
   * Where to go to act on this line (#1510). Null when there is nowhere to go
   * (applied rents, or a withheld rent whose holding has no public id).
   * Never an internal `asset_…` id — those are not a URL vocabulary (#1318).
   */
  href: string | null;
}

export interface FireRentReturnCopyInput {
  /**
   * Solo las dos listas: la renta neta agregada del informe es un INGRESO (#1428) y se
   * dice en la tarjeta de gasto sostenible, no en esta sección, que habla de la tasa.
   */
  report: Pick<FireRentReturnReport, "applied" | "notices">;
  /** Money formatter from the page (privacy mode included). */
  formatMoney: (amountMinor: number) => string;
  /**
   * Public `wl_hld_…` ids keyed by internal asset id. Missing entries mean the
   * line still prints, but without a ficha link.
   */
  publicIdByAssetId?: Readonly<Record<string, string>>;
}

/**
 * The lines to print, applied first. Empty when there is nothing to say — a
 * portfolio with no declared rent has no disclosure to make.
 */
export function fireRentReturnLines(
  input: FireRentReturnCopyInput,
): FireRentReturnLine[] {
  const { formatMoney, publicIdByAssetId = {}, report } = input;

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
      href: null,
      key: entry.assetId,
      kind: "applied",
      title: `${entry.assetName} · ${formatRatePercent(entry.rate)} real`,
    };
  });

  const withheld = report.notices.map(
    (notice): FireRentReturnLine => ({
      gloss: noticeGloss(notice),
      href: withheldHref(notice, publicIdByAssetId),
      key: notice.assetId,
      kind: "withheld",
      title: notice.assetName,
    }),
  );

  return [...applied, ...withheld];
}

function withheldHref(
  notice: RentReturnNotice,
  publicIdByAssetId: Readonly<Record<string, string>>,
): string | null {
  // Immobilized capital is a declaration on this page, not a field on the ficha.
  if (notice.reason === "immobilized_not_counted") {
    return "#supuestos";
  }
  const publicId = publicIdByAssetId[notice.assetId];
  return publicId ? holdingCobrosHref(publicId) : null;
}

function noticeGloss(notice: RentReturnNotice): string {
  switch (notice.reason) {
    case "missing_expenses":
      // The gross is named, and named as what it is NOT: seeing 6,3 % beside the
      // reason is what makes declaring the costs worth the trouble. The title is
      // the destination (#1510): the gloss no longer names «Cobros» or the ficha
      // as a place to go looking.
      return `Su alquiler declarado no se usa todavía: falta declarar sus gastos. Cuenta con el retorno por defecto de su tramo${
        notice.grossRate === null
          ? ""
          : `, no con el ${formatRatePercent(notice.grossRate)} que daría el alquiler bruto`
      }.`;
    case "no_live_schedule":
      return noLiveScheduleGloss(notice.scheduleWindow);
    case "foreign_currency":
      return "Está valorado en otra divisa y un cobro no lleva divisa propia, así que su alquiler no se usa para derivar la rentabilidad.";
    case "immobilized_not_counted":
      // Ni un fallo ni una invitación: es la consecuencia de lo que el usuario
      // declaró, así que la línea no le pide arreglar nada — le recuerda dónde se
      // cambia de opinión.
      return "Has declarado que tu patrimonio inmovilizado no cuenta como capital FIRE, así que su alquiler tampoco alimenta la rentabilidad esperada. Se cambia en «Tus supuestos».";
  }
}

const TIER_FALLBACK_CLAUSE = "cuenta con el retorno por defecto de su tramo";

/**
 * The sentence for `no_live_schedule` (#1511). The reason merges «terminó» with «aún no
 * empieza» because the rate does not care which it is; the reader does, and the merged
 * copy could only say the intersection («no está vigente hoy»), which names no date and
 * no action.
 *
 * So each case gets its own sentence, and the difference is not cosmetic:
 *
 * - **Ended**: something to do. The date says since when, and the action is named after
 *   the button that already exists on the schedule's row in the ficha's Cobros section
 *   (`_surfaces/cobros-section.tsx`). Naming it is not navigation instructions: the
 *   title of the line is itself the link to Cobros (#1510).
 * - **Pending**: nothing to do. A flat let in January is not a mistake, so the sentence
 *   states the date and stops; asking for a fix would be inventing a problem.
 * - **Both**: one payout ended and another is pending. Both dates are said, in calendar
 *   order, with no claim about which one is «the» reason.
 *
 * The last branch — neither side declared — is unreachable from `deriveRentRealReturns`
 * (a schedule that is not live is on one side or the other) but the record can express
 * it, so it is answered rather than thrown on. It is the only case where «no está
 * vigente hoy» is the honest sentence: with no date to give, saying more would be
 * inventing it. That is not the copy this issue removed, which said this while the
 * dates were sitting right there in the data.
 */
function noLiveScheduleGloss(scheduleWindow: RentScheduleWindow): string {
  const { endedOnISO: endedOn, startsOnISO: startsOn } = scheduleWindow;

  if (endedOn !== null && startsOn !== null) {
    return `Uno de sus alquileres declarados terminó el ${formatDay(endedOn)} y el siguiente empieza el ${formatDay(startsOn)}, así que hoy no alimenta la rentabilidad esperada: ${TIER_FALLBACK_CLAUSE}. Si el que terminó sigue alquilado, «Reactivar» lo vuelve a contar.`;
  }
  if (endedOn !== null) {
    return `Su alquiler declarado terminó el ${formatDay(endedOn)}, así que ya no alimenta la rentabilidad esperada: ${TIER_FALLBACK_CLAUSE}. Si sigue alquilado, «Reactivar» lo vuelve a contar.`;
  }
  if (startsOn !== null) {
    return `Su alquiler declarado empieza el ${formatDay(startsOn)}, así que todavía no alimenta la rentabilidad esperada: hasta entonces ${TIER_FALLBACK_CLAUSE}.`;
  }
  return `Su alquiler declarado no está vigente hoy, así que no alimenta la rentabilidad esperada: ${TIER_FALLBACK_CLAUSE}.`;
}
