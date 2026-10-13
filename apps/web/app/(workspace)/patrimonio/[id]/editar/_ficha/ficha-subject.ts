/**
 * What the holding is to its owner, and the words the ficha names it with (#1848):
 * an asset is an «activo»; a debt is not, and its ficha says «deuda» wherever the
 * holding is named — the page's region, the «Datos» tab, the header's regions.
 *
 * One map by subject, so the page and the island read the same words and a new
 * place that names the holding adds a field here instead of another ternary.
 */

export type FichaSubject = "activo" | "deuda";

export interface FichaSubjectWords {
  /** «del activo» / «de la deuda»: the header's regions, «Estado …», «Acciones …». */
  of: string;
  /** The page's region: «Ficha del activo». */
  ficha: string;
  /** The tab the page appends: «Datos del activo». */
  datos: string;
  /**
   * The value's class: a debt's figure carries the Línea del debe, as its pane does
   * on the board (canon §6) — the «−» alone is not what marks a pasivo.
   */
  valueClass: string;
}

export const FICHA_SUBJECT_WORDS: Readonly<Record<FichaSubject, FichaSubjectWords>> = {
  activo: {
    datos: "Datos del activo",
    ficha: "Ficha del activo",
    of: "del activo",
    valueClass: "fichaValue",
  },
  deuda: {
    datos: "Datos de la deuda",
    ficha: "Ficha de la deuda",
    of: "de la deuda",
    valueClass: "fichaValue debitCol",
  },
};
