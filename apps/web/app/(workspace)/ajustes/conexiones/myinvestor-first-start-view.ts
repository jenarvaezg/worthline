/**
 * The words of MyInvestor's first start (#1880, design D), pure and client-safe: the
 * history line of each product, the notes that say what another slice will do with
 * it, and the state of the connected row. The island and the server rows read the
 * same functions, so a row says the same thing before and after hydration.
 */
import type { MyInvestorProductRow } from "@web/ajustes/myinvestor-selection";

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
  if (row.block?.reason === "manual_twin") {
    notes.push(
      `Ya lo tienes a mano en «${row.block.holdingName}»: se revisará antes de enlazarlo, así que aún no se puede incluir`,
    );
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
