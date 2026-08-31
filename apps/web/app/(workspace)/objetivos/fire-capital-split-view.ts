import type { FireCapitalSide, FireCapitalSplit } from "@worthline/domain";
import { LIQUIDITY_TIER_LABELS, termLockedWithinSellableMinor } from "@worthline/domain";

/** One printed row of the eligible-capital breakdown (#1447). */
export interface FireCapitalSplitRow {
  key: "sellable" | "immobilized";
  /** What this side is called on paper. */
  label: string;
  /** Which rungs it is made of, plus what was netted out — the audit trail in words. */
  gloss: string;
  amountMinor: number;
  /**
   * True for a side the user declared out of their FIRE capital (#1460). The row is
   * printed anyway — it is patrimonio the user still owns — but attenuated and said
   * to be outside the figure: hiding it would make the capital look smaller than it
   * is, and printing it plain would make the total above look wrong.
   */
  outOfCalculation: boolean;
}

const SIDE_LABELS: Record<FireCapitalSplitRow["key"], string> = {
  immobilized: "inmovilizado",
  sellable: "vendible",
};

/**
 * Whether the eligible total is worth breaking apart (#1447). With nothing
 * immobilized there is no illusion of liquidity to undo, and two rows saying
 * "all of it is sellable" would be noise on a portfolio that is exactly that.
 */
export function shouldShowCapitalSplit(split: FireCapitalSplit): boolean {
  return split.immobilized.grossMinor > 0;
}

/**
 * The breakdown rows for `Activos elegibles`. Pure and label-only: the amounts
 * come from `splitFireCapital`, which already guarantees they add back up to
 * the eligible figure above them.
 */
export function fireCapitalSplitRows(split: FireCapitalSplit): FireCapitalSplitRow[] {
  return [
    buildRow("sellable", split.sellable, false),
    buildRow("immobilized", split.immobilized, !split.countsImmobilized),
  ];
}

function buildRow(
  key: FireCapitalSplitRow["key"],
  side: FireCapitalSide,
  outOfCalculation: boolean,
): FireCapitalSplitRow {
  const tiers = side.tiers.map((tier) => LIQUIDITY_TIER_LABELS[tier]);
  const subtractions: string[] = [];
  if (side.debtMinor > 0) {
    subtractions.push("su deuda");
  }
  if (side.reservedMinor > 0) {
    subtractions.push("lo reservado para objetivos");
  }
  // The other side's debt landed here because its collateral did not cover it;
  // saying so is what keeps the figure and its gloss from contradicting.
  if (side.absorbedDebtMinor > 0) {
    subtractions.push("la deuda que su garantía no cubre");
  }

  const base = tiers.length > 0 ? tiers.join(" + ") : "sin activos";
  const withDebt =
    subtractions.length > 0 ? `${base} − ${subtractions.join(" y ")}` : base;
  // Primero qué es la cifra y después que no está dentro: al revés, la glosa recortada
  // en la columna estrecha se quedaría justo en «fuera del cálculo» sin decir de qué.
  const gloss = outOfCalculation ? `${withDebt} · fuera del cálculo` : withDebt;

  return {
    amountMinor: side.amountMinor,
    gloss,
    key,
    label: SIDE_LABELS[key],
    outOfCalculation,
  };
}

/**
 * What the sellable side alone funds, as a percentage of the FIRE number — the
 * figure the single "68,5 % financiado" hides when two thirds of the pool is
 * brick. Null when there is no FIRE number to measure against.
 *
 * Also null when the user declared the brick out (#1460): the headline percentage is
 * then ALREADY the sellable one, and printing «solo con lo vendible estarías al 4,6 %»
 * next to a hero reading 4,6 % would invent a second measure where there is one.
 */
export function sellableFundedPercent(
  split: FireCapitalSplit,
  fireNumberMinor: number,
): number | null {
  if (fireNumberMinor <= 0 || !split.countsImmobilized) {
    return null;
  }
  return (split.sellable.amountMinor / fireNumberMinor) * 100;
}

/**
 * Lo que el lado vendible **no** dice por sí solo (#1523): que dentro lleva capital
 * bloqueado hasta una fecha o una edad — el plan de pensiones, el depósito.
 *
 * La fila «vendible» responde «esto se puede vender a trozos», y sobre el escalón
 * `term-locked` esa respuesta es cierta a treinta años y falsa hoy. El veredicto de
 * #1523 fue dejar el peldaño donde está (para un FIRE perpetuo la clasificación es
 * defendible: un plazo vence) y **romper el silencio**, que era la parte insostenible.
 *
 * La cifra sale de `termLockedWithinSellableMinor`, que es un corte del mismo reparto
 * que produjo la fila y viene ya topada a su neto: la nota no puede nombrar más
 * capital a plazo que el que la fila de encima está imprimiendo (ADR 0077).
 *
 * Null cuando no hay nada en el escalón, o cuando la deuda y la reserva se comieron el
 * lado entero: una glosa fija que apareciera siempre dejaría de leerse.
 *
 * Habla de **cuánto**, nunca de *cuándo*. El calendario lo declara cada holding y lo
 * cuenta la tarjeta del gasto sostenible (#1528, ADR 0100); repetirlo aquí sería la
 * segunda opinión que el reparto no puede permitirse. Por eso tampoco arranca como
 * arranca aquella («De tu capital vendible, …»): las dos frases pueden coincidir en la
 * misma pantalla y con el mismo importe, y dos aperturas iguales las harían leerse como
 * una repetición en vez de como las dos preguntas distintas que son — cuánto hay
 * bloqueado, y qué hace el reparto con ello.
 *
 * Y nombra el lado solo cuando el lado está impreso: sin nada inmovilizado no hay
 * desglose (`shouldShowCapitalSplit`), así que «lo vendible» sería un término que la
 * pantalla no ha enseñado. Entonces la frase se apoya en la cifra que sí está ahí, los
 * activos elegibles — que en esa cartera son exactamente el lado vendible.
 */
export function sellableTermLockedNote(
  split: FireCapitalSplit,
  formatMoney: (amountMinor: number) => string,
): string | null {
  const lockedMinor = termLockedWithinSellableMinor(split);
  if (lockedMinor <= 0) {
    return null;
  }

  const whereFrom = shouldShowCapitalSplit(split)
    ? "Dentro de lo vendible hay"
    : "Dentro de tus activos elegibles hay";

  return `${whereFrom} ${formatMoney(lockedMinor)} en el escalón «${LIQUIDITY_TIER_LABELS["term-locked"]}»: capital bloqueado hasta una fecha o una edad (un plan de pensiones, un depósito). Cuenta en la cifra de arriba porque un plazo acaba venciendo y la tasa de retirada es una regla a décadas, no porque se pueda tocar hoy.`;
}
