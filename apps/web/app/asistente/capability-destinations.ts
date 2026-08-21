/**
 * Where worthline does each thing — ONE map, read by the system prompt and by the
 * maintainer alert's refusal message (#1524).
 *
 * The failure it closes, from a real transcript (2026-08-21): a user asked «¿dónde
 * introduzco los gastos declarados en las viviendas alquiladas?» and the assistant
 * answered from memory, without a single read, that «el registro de gastos operativos
 * sobre una vivienda no se introduce directamente» — then held that line for three
 * turns, defended it with an invented architecture («worthline no tiene un libro de
 * contabilidad de ingresos/gastos») and sent him to a spreadsheet. The field has
 * existed since #1448 (ADR 0076) and sits one `get_holding_detail` away. His three
 * properties are still expense-less, so his FIRE keeps valuing bricks at the tramo's
 * default return instead of their net rent.
 *
 * So the asymmetry this map serves is the point of it: «yo no puedo hacerlo» and «no
 * sé dónde se hace» are sentences the assistant may say, and «worthline no lo hace»
 * is not — for the user, the assistant IS the app talking.
 *
 * Why a module and not two prose lists: the destinations were ALREADY written once,
 * buried inside `maintainer-alert-evidence.ts`'s refusal message, and the rent entry
 * was missing from it. Two copies would have drifted the moment one grew a surface;
 * one copy cannot.
 */

/** A capability the user asks about, and the surface that owns it. */
export interface CapabilityDestination {
  /** Stable key, so a caller or a test names an entry without matching its prose. */
  id: "holding-identity" | "connected-source" | "rent-expenses";
  /** The capability in the user's words plus where worthline does it. */
  where: string;
  /**
   * A workaround that has to be refused BY NAME. Only for the ones a cornered model
   * keeps reaching for: naming it is cheaper than hoping the positive rule wins.
   */
  neverInstead?: string;
}

export const CAPABILITY_DESTINATIONS: CapabilityDestination[] = [
  {
    id: "holding-identity",
    // Halved in #1349 and it stays halved: the chat CAN fill an EMPTY isin/symbol,
    // so only overwriting one that already has a value belongs to the ficha.
    where:
      "cambiar un nombre, ISIN o símbolo que YA tiene se hace en su ficha, en " +
      "/patrimonio abriendo la posición — por chat solo se rellena el vacío",
  },
  {
    id: "connected-source",
    // Just the surface: the prompt's own connected-source bullet already spells out
    // that the sync owns the data and that writing to it is refused.
    where: "una fuente conectada se gobierna en /ajustes/conexiones",
  },
  {
    id: "rent-expenses",
    // The entry that was missing (#1524). Three things a usable answer needs and the
    // transcript had none of: «Configuración avanzada», because the Cobros section is
    // inside that collapsed `<details>` and an answer that omits it sends the user
    // hunting (which is #1510, the sibling failure, seen from this side); the field's
    // own name; and the cadence — a monthly rent with an annual IBI typed in raw
    // would net out to nonsense.
    where:
      "los gastos de un alquiler (IBI, comunidad, seguro) se declaran en la ficha del " +
      "inmueble, desplegando «Configuración avanzada» → «Cobros», campo Gastos del " +
      "cobro recurrente, en la MISMA cadencia que su importe",
    // WHY it does not work — the engine discards a rent with no declared expenses —
    // belongs to `get_holding_detail`, which is where the model reads that field.
    // Here it is only named as refused, so the two do not say ADR 0076 twice.
    neverInstead:
      "meter el alquiler NETO en el campo Importe no vale: estropea el libro de cobros, " +
      "que registra lo que LLEGÓ (ADR 0054), y encima no arregla el cálculo (ADR 0076)",
  },
];

/**
 * The map as one sentence, for a prompt or a refusal message. The banned workarounds
 * ride along at the end: they are part of the answer to «¿dónde se hace?», because the
 * transcript that opened #1524 shows what a model does when it only has the negative.
 */
export function renderCapabilityDestinations(): string {
  const where = CAPABILITY_DESTINATIONS.map((entry) => entry.where).join("; ");
  const never = CAPABILITY_DESTINATIONS.flatMap((entry) => entry.neverInstead ?? []);
  return never.length === 0 ? `${where}.` : `${where}. Y ${never.join("; ")}.`;
}
