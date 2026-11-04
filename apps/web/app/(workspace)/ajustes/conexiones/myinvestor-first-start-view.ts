/**
 * The words of MyInvestor's first start (#1880, design D), pure and client-safe: the
 * history line of each product, the notes that say what another slice will do with
 * it, the careo of a product a manual holding already is (#1881, design C) and the
 * state of the connected row. The island and the server rows read the same
 * functions, so a row says the same thing before and after hydration.
 */
import type {
  MyInvestorCareo,
  MyInvestorCareoMark,
  MyInvestorCareoPlan,
} from "@web/ajustes/myinvestor-careo";
import type {
  MyInvestorProductRow,
  MyInvestorTwin,
  MyInvestorTwinChoice,
} from "@web/ajustes/myinvestor-selection";
import { myInvestorLinkChoice } from "@web/ajustes/myinvestor-selection";
import { operationKindLabel } from "@web/operation-kind-copy";
import type { ContributionCadence, PlannedContributionAmount } from "@worthline/domain";
import { formatUnits } from "@worthline/domain";

const MONTH_YEAR = new Intl.DateTimeFormat("es-ES", {
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

/** `2024-03-18` → «mar 2024». */
export function myInvestorSinceLabel(day: string): string {
  return MONTH_YEAR.format(new Date(`${day}T00:00:00.000Z`)).replace(".", "");
}

/** What history the product brings: «31 operaciones desde mar 2024». */
export function myInvestorHistoryLine(row: MyInvestorProductRow): string | null {
  if (row.kind === "cash") return "Saldo de hoy, sin movimientos";
  if (row.kind === "managed") return null;
  if (row.operations === 0 || row.since === null) return "Sin operaciones terminadas";
  const noun = row.operations === 1 ? "operación" : "operaciones";
  return `${row.operations} ${noun} desde ${myInvestorSinceLabel(row.since)}`;
}

/**
 * The notes under a product, each one line with the gold rule: what is already
 * counted, and what another slice still has to do before it can be linked.
 */
export function myInvestorRowNotes(
  row: MyInvestorProductRow,
  money: (minor: number) => string,
): string[] {
  const notes: string[] = [];
  if (row.withheldMinor !== null) {
    notes.push(
      `${money(row.withheldMinor)} retenidos por órdenes en curso, ya dentro del saldo`,
    );
  }
  if (row.inheritedCostPending) {
    notes.push("Entró por traspaso desde otra entidad: te preguntaremos lo que costó");
  }
  if (row.block?.reason === "managed_portfolio") {
    const members = row.members.length > 0 ? `: ${row.members.join(" · ")}` : "";
    notes.push(
      `Se enlazará entera, como cartera gestionada${members}. Aún no se puede incluir`,
    );
  }
  if (row.block?.reason === "currency") {
    notes.push("Opera en otra divisa: aún no se puede incluir");
  }
  return notes;
}

export type MyInvestorRowState =
  | { readonly kind: "read"; readonly label: string }
  | { readonly kind: "choose"; readonly label: string }
  | { readonly kind: "fresh"; readonly label: string }
  | { readonly kind: "stale"; readonly label: string };

/**
 * The state cell of the connected row: what to do next until something is included,
 * then whether its last read is today's (the daily update is #1884's).
 */
export function myInvestorRowState(input: {
  hasDiscovery: boolean;
  linkedCount: number;
  lastSyncAt: string | null;
  today: string;
}): MyInvestorRowState {
  if (input.linkedCount === 0) {
    return input.hasDiscovery
      ? { kind: "choose", label: "Falta elegir qué incluir" }
      : { kind: "read", label: "Falta leer tus productos" };
  }
  return input.lastSyncAt?.slice(0, 10) === input.today
    ? { kind: "fresh", label: "Al día" }
    : { kind: "stale", label: "Desactualizado" };
}

// ── The careo of a twin (#1881, design C) ────────────────────────────────────

const SHORT_MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** `2024-09-05` → «5 sep 2024». */
export function myInvestorShortDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${Number(date)} ${SHORT_MONTHS[Number(month) - 1] ?? month} ${year}`;
}

function schemeLabel(scheme: MyInvestorTwin["scheme"]): string {
  return scheme === "dgs" ? "código DGS" : "ISIN";
}

/** Why a product is a twin, above its three choices. */
export function myInvestorTwinLegend(twin: MyInvestorTwin): string {
  const names = twin.candidates.map((candidate) => `«${candidate.name}»`);
  const scheme = schemeLabel(twin.scheme);
  if (twin.reason === "identifier") {
    return names.length === 1
      ? `Ya lo tienes a mano con el mismo ${scheme} en ${names[0]}.`
      : `Ya tienes a mano ${names.length} holdings con el mismo ${scheme}: ${names.join(", ")}. Elige con cuál enlazarlo.`;
  }
  return names.length === 1
    ? `Se parece por el nombre a ${names[0]}, que no tiene ${scheme}. ¿Es el mismo?`
    : `Se parece por el nombre a ${names.join(", ")}, que no tienen ${scheme}. ¿Es alguno el mismo?`;
}

/** The three ways out of a twin, as the radios read them. */
export function myInvestorTwinOptions(
  twin: MyInvestorTwin,
): { value: MyInvestorTwinChoice; label: string; note: string | null }[] {
  return [
    ...twin.candidates.map((candidate) => ({
      label: `Enlazar con «${candidate.name}»: MyInvestor sustituye sus operaciones`,
      note:
        candidate.pairedWith.length === 0
          ? null
          : `Tiene un traspaso con ${candidate.pairedWith
              .map((pair) => `«${pair.name}»`)
              .join(", ")}: enlázalos a la vez, o deshaz el traspaso antes.`,
      value: myInvestorLinkChoice(candidate.assetId),
    })),
    {
      label: "Crear aparte: contaría dos veces si es el mismo",
      note: null,
      value: "separate",
    },
    { label: "No incluir", note: null, value: "skip" },
  ];
}

const WEEKDAYS = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
];

function cadenceLabel(cadence: ContributionCadence): string {
  switch (cadence.kind) {
    case "monthly":
      return `el día ${cadence.dayOfMonth} de cada mes`;
    case "weekly":
      return `cada ${WEEKDAYS[cadence.weekday - 1]}`;
    case "quarterly":
      return "cada trimestre";
    case "annual":
      return "cada año";
  }
}

function amountLabel(
  amount: PlannedContributionAmount,
  money: (minor: number) => string,
): string {
  return amount.mode === "money"
    ? money(amount.value)
    : `${formatUnits(amount.value)} participaciones`;
}

/** What linking does to the holding's contribution plan (ADR 0115 decision 5). */
export function myInvestorPlanSentence(
  plan: MyInvestorCareoPlan,
  money: (minor: number) => string,
): string {
  const [only] = plan.lines;
  const closes =
    plan.lines.length === 0
      ? null
      : plan.lines.length === 1 && only
        ? `Tu plan de ${amountLabel(only.amount, money)} ${cadenceLabel(only.cadence)} se cierra hoy`
        : `Tus ${plan.lines.length} líneas del plan de aportación se cierran hoy`;
  const pending =
    plan.pending === 0
      ? null
      : plan.pending === 1
        ? "su aportación pendiente se da por cerrada"
        : `sus ${plan.pending} aportaciones pendientes se dan por cerradas`;
  if (closes && pending) return `${closes} y ${pending}.`;
  if (closes) return `${closes}.`;
  return `De tu plan de aportación, ${pending ?? ""}.`;
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/**
 * The verdict in one sentence with figures (design C): what pairs, what leaves and
 * what enters, the units, the cost and the average cost before and after, and the
 * plan that closes.
 */
export function myInvestorCareoVerdict(
  careo: MyInvestorCareo,
  money: (minor: number) => string,
): string {
  const { counts, before, after } = careo;
  const parts: string[] = [];
  if (counts.manual === 0) {
    parts.push(
      counts.enters === 1
        ? "No tenías operaciones a mano: entra 1 de MyInvestor."
        : `No tenías operaciones a mano: entran ${counts.enters} de MyInvestor.`,
    );
  } else {
    parts.push(
      `Coinciden ${counts.same} de ${count(counts.manual, "operación tuya", "operaciones tuyas")}.`,
    );
    const leaves =
      counts.leaves === 0
        ? "No se va ninguna tuya"
        : counts.leaves === 1
          ? "Se va 1 tuya"
          : `Se van ${counts.leaves} tuyas`;
    const enters =
      counts.enters === 0
        ? "no entra ninguna de MyInvestor"
        : counts.enters === 1
          ? "entra 1 de MyInvestor"
          : `entran ${counts.enters} de MyInvestor`;
    parts.push(`${leaves} y ${enters}.`);
  }
  parts.push(
    `Participaciones ${formatUnits(before.units)} → ${formatUnits(after.units)}; coste ${money(before.costMinor)} → ${money(after.costMinor)}; coste medio ${money(before.averageMinor)} → ${money(after.averageMinor)}.`,
  );
  if (careo.plan) parts.push(myInvestorPlanSentence(careo.plan, money));
  return parts.join(" ");
}

export const MYINVESTOR_CAREO_MARK_LABEL: Record<MyInvestorCareoMark, string> = {
  enters: "+ entra",
  leaves: "− se va",
  same: "= coincide",
};

/** One row of «Ver las N operaciones», in words. */
export function myInvestorCareoRowCells(
  row: MyInvestorCareo["rows"][number],
  money: (minor: number) => string,
): {
  date: string;
  kind: string;
  amount: string;
  units: string;
  mark: string;
  hint: string | null;
} {
  return {
    amount: money(row.amountMinor),
    date: myInvestorShortDay(row.date),
    hint:
      row.near === null
        ? null
        : `igual que la del ${myInvestorShortDay(row.near)}: revisa la fecha`,
    kind: operationKindLabel(row.kind),
    mark: MYINVESTOR_CAREO_MARK_LABEL[row.mark],
    units: formatUnits(row.units),
  };
}
