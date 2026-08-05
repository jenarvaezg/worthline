/**
 * The es-ES copy of a reconcile row and of its impact caption (#1373) — the words
 * the card prints, extracted from the component so they can be asserted without
 * rendering React and so the card is left with layout only.
 *
 * Why the wording is code and not JSX: the card was telling four lies at once (a
 * `+0 €` header over a document stating +125 €, a fidelity tier where the evidence
 * should be, a caption naming «altas» in a batch with none, and a target the user
 * could not compare against the document text). Each of those is a sentence, and a
 * sentence that matters is worth a test.
 *
 * Pure and I/O-free (`docs/interaction-patterns.md`, ADR 0036): plain shapes in,
 * strings out, no store and no clock.
 */

import {
  countKeyClaimants,
  formatMoneyMinor,
  formatMoneyMinorExact,
} from "@worthline/domain";

import { formatDayEs } from "./early-repayment-impact";
import {
  effectiveDecision,
  type ReconcileImpact,
  type ReconcileRow,
  type ReconcileRowMovement,
} from "./reconcile-plan";

/**
 * Money as the document states it: whole euros in the app's reading voice
 * (`formatMoneyMinor`), and the cents shown whenever there are any. A figure the
 * user is checking against a PDF may not be rounded away — 125,50 € printed as
 * «126 €» is the same class of lie this card exists to stop (#1315, #1329) — but a
 * round 125 € does not have to grow a «,00» either.
 */
export function formatDocumentMoney(amountMinor: number): string {
  const money = { amountMinor, currency: "EUR" as const };
  return amountMinor % 100 === 0 ? formatMoneyMinor(money) : formatMoneyMinorExact(money);
}

/**
 * es-ES participaciones and unit price. Four decimals on the price: a derived NAV
 * (125 € / 5,92 part.) is periodic, and the four decimals a fund quotes are the
 * reading voice — six would print noise the document does not contain.
 */
function formatUnitCount(units: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(units);
}

function formatUnitPrice(price: number): string {
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 }).format(price)} €`;
}

/**
 * A movement in a currency this lane cannot write. It is printed in ITS currency —
 * converting it here would invent a rate — and said out loud, because the confirm
 * skips it and a silently dropped line is the kind of gap this row exists to close.
 */
function formatForeignMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("es-ES", {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/**
 * How a movement's kind reads in the row — the DOCUMENT's word, not the operation's.
 * The confirm writes a `contribution` as a buy (an aportación to a plan de pensiones
 * is a purchase of participaciones), and the row could say «compra» for both; it says
 * «aportación» because this line exists to be compared against the paper in the
 * user's hand, and the paper says «APORTACION P.P.». What is written is the same
 * either way — the units, the price and the amount below say so.
 */
const MOVEMENT_KIND_LABELS: Record<ReconcileRowMovement["kind"], string> = {
  buy: "compra",
  contribution: "aportación",
  sell: "venta",
};

/**
 * One printed movement: `05/08/2026 · compra · 5,92 part. × 21,1149 € · 125 €`.
 * Participaciones and price appear only when the document brings them; the amount
 * always does, and a currency this lane cannot write is named rather than dropped,
 * so a row that will write nothing says why on its own line.
 */
export function reconcileMovementLine(movement: ReconcileRowMovement): string {
  const parts = [formatDayEs(movement.date), MOVEMENT_KIND_LABELS[movement.kind]];
  if (movement.units !== undefined && movement.unitPrice !== undefined) {
    parts.push(
      `${formatUnitCount(movement.units)} part. × ${formatUnitPrice(movement.unitPrice)}`,
    );
  }
  parts.push(
    movement.currency === "EUR"
      ? formatDocumentMoney(Math.abs(movement.signedAmountMinor))
      : `${formatForeignMoney(Math.abs(movement.signedAmountMinor), movement.currency)} · fuera de alcance`,
  );
  return parts.join(" · ");
}

/** The es-ES fidelity mark a reconcile row shows (decision #1090, ADR 0048). */
export function reconcileFidelityMark(fidelity: ReconcileRow["fidelity"]): string {
  if (fidelity === "movements") return "con movimientos";
  if (fidelity === "declared_cost") return "coste declarado";
  return "sin coste real";
}

/**
 * What the row says the document names — printed on its OWN line, above the
 * destination (#1373). The two used to be indistinguishable: the model typed the
 * name of the wrong plan de pensiones into the row, so the title and the
 * «Actualizar «…»» button read the same and the jump was invisible.
 */
export function reconcileDocumentLine(row: ReconcileRow): string {
  return row.isin === undefined ? row.name : `${row.name} · ${row.isin}`;
}

/** The es-ES destination line: what this row will do, and to which holding. */
export function reconcileDestinationLabel(row: ReconcileRow): string {
  const decision = effectiveDecision(row);
  if (decision === "leave") return "Dejar";
  if (decision === "create") return `Crear «${row.name}»`;
  const target = row.match.candidates.find((c) => c.holdingId === row.match.target);
  return `Actualizar «${target?.name ?? row.name}»`;
}

/**
 * The es-ES review mark of an ambiguous match (#1331): the key names the instrument
 * but not the holding — the same fondo at two brokers, or two holdings with el mismo
 * nombre — so the row says how many it is choosing between instead of presenting a
 * confident target. Empty once the user picks one (the pick resolves the ambiguity).
 */
export function reconcileAmbiguityMark(row: ReconcileRow): string {
  if (!row.match.ambiguous || effectiveDecision(row) !== "update") return "";
  const shared = row.match.key === "name" ? "el mismo nombre" : "el mismo identificador";
  return ` · ${countKeyClaimants(row.match)} holdings con ${shared}: revisa cuál actualizas`;
}

/**
 * The caption under the impact header. Two things it must never do again (#1373):
 * say «sobre las altas» in a batch that has none, and present a movement-backed sum
 * as final. So it names what the sum is BUILT FROM, and it keeps «estimado»
 * whenever either something is missing from the sum or the sum rests on movements —
 * whose units the ripple will revalue at today's price.
 */
export function reconcileImpactCaption(impact: ReconcileImpact): string {
  const sources = [
    ...(impact.includesCreates ? ["las altas"] : []),
    ...(impact.includesMovements ? ["los movimientos"] : []),
  ];
  const estimated = impact.partial || impact.includesMovements;
  if (sources.length === 0) return estimated ? "estimado" : "";
  return `${estimated ? "estimado " : ""}sobre ${sources.join(" y ")}`;
}
