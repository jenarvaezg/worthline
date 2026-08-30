/**
 * The audit of the traspasos ALREADY in the book (#1519) — pure rule.
 *
 * The atomic gate of #1479 guarantees that a NEW traspaso is written whole or not
 * at all. Nobody checks what is already written, and two paths can leave a leg on
 * its own: the one-shots of `.local/scripts`, which write without crossing the
 * gate, and the retroactive re-typing of #1485, which puts a `transferId` on rows
 * that did not carry one. When it happens the symptom is silent and expensive to
 * diagnose: a `transferId` with no other half is indistinguishable from a cost
 * leak in the engine, and the reconciliation of 21-08-2026 spent a whole audit of
 * the ledger ruling exactly that out.
 *
 * Two invariants per `transferId`, and the second one cannot be written as a
 * column comparison: `transferCostMinor` does not exist on the outgoing leg, by
 * design — it "rides ONLY the `transfer_in`, so the position fold never has to
 * cross over to another asset's ledger". So the cost that LEFT has to be derived
 * the same way `planTransfer` derived it when it wrote the pair: fold the origin's
 * own ledger up to the operation before the traspaso, then take the same
 * proportion of its cost basis. One fold per pair — 21 pairs in Jorge's book.
 *
 * Tolerance is ZERO (#1422): the same call of the same engine is compared against
 * itself, so a cent of difference is corrupt data, never a rounding.
 */

import { compareUnits, type DecimalString, proportionMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { type CurrencyCode, formatMoneyMinorExact, money } from "./money";
import { compareInvestmentOperations, derivePosition } from "./positions";

/**
 * Why a pair is broken. The two faults are exclusive and in this order: without
 * exactly one leg on each side there is no origin to fold and no declared cost to
 * careo, so a cardinality fault swallows the cost question rather than reporting a
 * drift derived from a leg that may not be the right one.
 */
export type TransferPairFault =
  | {
      kind: "cardinality";
      /** `transfer_out` rows sharing the id — the invariant says exactly one. */
      outCount: number;
      /** `transfer_in` rows sharing the id — the invariant says exactly one. */
      inCount: number;
      /**
       * Rows sharing the id that are neither half — a `buy` or `sell` carrying a
       * `transferId`, which is the fail-open shape the separate kinds exist to
       * prevent (#1393). Counted apart from `outCount` so the line says what is
       * actually there to go and fix, instead of calling a contaminated buy a
       * second outgoing leg.
       */
      strayCount: number;
    }
  | {
      kind: "cost_drift";
      /** What the incoming row says it inherited (0 when the column is absent). */
      declaredCostMinor: number;
      /** What the fold actually removes from the origin on that day. */
      derivedCostMinor: number;
      /** `declared − derived`. Signed: positive means the book gained cost. */
      deltaMinor: number;
    };

/** One traspaso that fails an invariant, with the holdings its legs touch. */
export interface BrokenTransferPair {
  transferId: string;
  fault: TransferPairFault;
  /** The holdings the pair's legs sit on, sorted — its legs' `assetId`s. */
  holdingIds: readonly string[];
}

export interface AuditTransferPairsInput {
  /**
   * The WORKSPACE's investment ledger, keyed by holding — not a scope's slice.
   *
   * The cardinality check reads absence as evidence, so a narrowed map would
   * fabricate orphans out of pairs whose other half is simply not in view. The
   * scope question is answered afterwards by {@link AuditTransferPairsInput.holdingIds},
   * which decides which pairs are REPORTED, never which rows are counted.
   */
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /**
   * Restrict the report to pairs with a leg on one of these holdings. Absent
   * audits the whole map.
   */
  holdingIds?: ReadonlySet<string> | undefined;
}

/** One traspaso's legs, gathered from across the whole ledger. */
interface TransferLegs {
  out: InvestmentOperation[];
  incoming: InvestmentOperation[];
  /** Rows carrying the id that are neither half — a shape no writer produces. */
  strays: InvestmentOperation[];
}

/**
 * Every traspaso in the ledger that fails an invariant, in a stable order by
 * `transferId`.
 *
 * Two shapes are NOT faults, and both are a `transfer_in` standing alone:
 *
 * - **With no `transferId`** — the plain way to declare capital arriving from
 *   outside the book. Nothing pairs it and nothing is claimed about an origin.
 * - **With a `transferId` of its own and no outgoing half anywhere** — the
 *   EXTERNAL ENTRY (#1541): a plan brought in from another institution, whose
 *   outgoing half lives in that institution's ledger and can never be written
 *   here. Its own id exists precisely "so a reader finds one row and names it
 *   «desde otra entidad» instead of reporting a broken pair" (CONTEXT.md, ADR
 *   0083 decisión 7). This audit reads the same evidence the ficha reads and must
 *   reach the same verdict (#1422) — otherwise the row says «desde otra entidad»
 *   on one screen and «roto» on another. Its inherited cost is DECLARED by the
 *   user, not derived, so there is nothing to careo either.
 *
 * A lone `transfer_out` has no such reading: nothing in the app writes one, and
 * capital that left with neither a destination nor a sale is exactly the shape the
 * one-shots and the re-typing of #1485 can leave behind.
 */
export function auditTransferPairs(input: AuditTransferPairsInput): BrokenTransferPair[] {
  const legsByTransferId = groupLegs(input.operationsByAssetId);
  const broken: BrokenTransferPair[] = [];

  for (const [transferId, legs] of legsByTransferId) {
    const holdingIds = legHoldingIds(legs);
    if (input.holdingIds && !holdingIds.some((id) => input.holdingIds?.has(id))) {
      continue;
    }

    const fault = faultOf(legs, input.operationsByAssetId);
    if (fault !== null) {
      broken.push({ fault, holdingIds, transferId });
    }
  }

  return broken.sort((left, right) => left.transferId.localeCompare(right.transferId));
}

function groupLegs(
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>,
): Map<string, TransferLegs> {
  const legsByTransferId = new Map<string, TransferLegs>();

  for (const operations of operationsByAssetId.values()) {
    for (const operation of operations) {
      const transferId = operation.transferId;
      if (transferId === undefined) continue;

      const legs = legsByTransferId.get(transferId) ?? {
        incoming: [],
        out: [],
        strays: [],
      };
      if (operation.kind === "transfer_out") {
        legs.out.push(operation);
      } else if (operation.kind === "transfer_in") {
        legs.incoming.push(operation);
      } else {
        // A `buy` or `sell` carrying a `transferId` is exactly the fail-open shape
        // the separate kinds exist to prevent (#1393). Counted as a stray so the
        // cardinality reads wrong rather than the row being quietly ignored.
        legs.strays.push(operation);
      }
      legsByTransferId.set(transferId, legs);
    }
  }

  return legsByTransferId;
}

function legHoldingIds(legs: TransferLegs): string[] {
  return [
    ...new Set(
      [...legs.out, ...legs.incoming, ...legs.strays].map(
        (operation) => operation.assetId,
      ),
    ),
  ].sort();
}

function faultOf(
  legs: TransferLegs,
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>,
): TransferPairFault | null {
  const out = legs.out[0];
  const incoming = legs.incoming[0];

  // The external entry: one incoming row, no origin anywhere. Legitimate, and
  // silent — see this module's own doc.
  if (legs.out.length === 0 && legs.incoming.length === 1 && legs.strays.length === 0) {
    return null;
  }

  if (
    legs.out.length !== 1 ||
    legs.incoming.length !== 1 ||
    legs.strays.length > 0 ||
    out === undefined ||
    incoming === undefined
  ) {
    return {
      inCount: legs.incoming.length,
      kind: "cardinality",
      outCount: legs.out.length,
      strayCount: legs.strays.length,
    };
  }

  const derivedCostMinor = costLeavingOrigin(out, operationsByAssetId);
  // A `transfer_in` with no inherited cost is read as zero, exactly as the fold
  // reads it — the careo asks what the ledger HOLDS, not what a writer intended.
  const declaredCostMinor = incoming.transferCostMinor ?? 0;
  const deltaMinor = declaredCostMinor - derivedCostMinor;

  return deltaMinor === 0
    ? null
    : { declaredCostMinor, deltaMinor, derivedCostMinor, kind: "cost_drift" };
}

/**
 * The acquisition cost the outgoing leg takes out of its origin: the same
 * `proportionMinor` over the same fold that `planTransfer` used to write the pair,
 * and that `derivePosition` uses to remove it every time the position is read.
 *
 * The units are CLAMPED to the position, as the fold clamps them. An over-transfer
 * the gate would have refused can only remove the cost that is actually there, so
 * clamping is what makes the comparison say "what the fold removes" rather than
 * "what a division of the stated units would have removed" — and a row that
 * inherited the un-clamped proportion is then reported, instead of agreeing with a
 * figure the book never held.
 *
 * "Up to the operation before" is decided by the fold's OWN comparator, not by the
 * row's index in the array: the same question is then answered the same way whether
 * or not the outgoing row itself is present under that key, so a ledger keyed in a
 * way this module did not expect cannot quietly fold the traspaso (and everything
 * after it) into the origin it is being careado against.
 */
function costLeavingOrigin(
  out: InvestmentOperation,
  operationsByAssetId: ReadonlyMap<string, readonly InvestmentOperation[]>,
): number {
  const before = (operationsByAssetId.get(out.assetId) ?? []).filter(
    (operation) => compareInvestmentOperations(operation, out) < 0,
  );

  const position = derivePosition(before, {
    assetId: out.assetId,
    currency: out.currency,
  });

  const unitsHeld: DecimalString = position.currentUnits;
  const outgoingUnits = compareUnits(out.units, unitsHeld) > 0 ? unitsHeld : out.units;

  return proportionMinor(position.costBasis.amountMinor, outgoingUnits, unitsHeld);
}

/**
 * The es-ES line the health signal shows: how many pairs are broken and which, in
 * the aggregation shape of #654 — one line for the whole book, never one per pair.
 *
 * It names the `transferId` rather than a holding on purpose: the id is what a
 * maintainer greps the ledger with, and half the faults are precisely a pair whose
 * second holding cannot be named because its row is missing.
 *
 * EVERY broken pair is named, with no cap. The ids ARE the deliverable — this line
 * is the only channel that carries them, so a "y 3 más" would drop exactly what the
 * reader came for. What bounds the length is the corruption itself: the ordinary
 * reading is zero, and a book with dozens of broken pairs has a problem the length
 * of a label is not the worst part of.
 */
export function describeBrokenTransferPairs(
  pairs: readonly BrokenTransferPair[],
  currency: CurrencyCode,
): string {
  const count = pairs.length;
  const opening =
    count === 1
      ? "1 traspaso del libro no cuadra consigo mismo"
      : `${count} traspasos del libro no cuadran consigo mismos`;

  const detail = pairs
    .map((pair) => `${pair.transferId} (${describeFault(pair.fault, currency)})`)
    .join("; ");

  return `${opening}: ${detail}. Ninguna cifra de la pantalla lo dice, pero el coste de adquisición que viajó ya no se puede reconstruir desde el origen.`;
}

function describeFault(fault: TransferPairFault, currency: CurrencyCode): string {
  if (fault.kind === "cardinality") {
    if (fault.outCount === 1 && fault.inCount === 0 && fault.strayCount === 0) {
      return "sin su mitad de entrada";
    }
    const legs = `${fault.outCount} ${legWord(fault.outCount, "salida", "salidas")} y ${fault.inCount} ${legWord(fault.inCount, "entrada", "entradas")}`;
    return fault.strayCount === 0
      ? legs
      : `${legs}, más ${fault.strayCount} ${legWord(fault.strayCount, "operación que no es ninguna de las dos mitades", "operaciones que no son ninguna de las dos mitades")}`;
  }

  const declared = formatMoneyMinorExact(money(fault.declaredCostMinor, currency));
  const derived = formatMoneyMinorExact(money(fault.derivedCostMinor, currency));
  const delta = formatMoneyMinorExact(money(Math.abs(fault.deltaMinor), currency));
  const direction = fault.deltaMinor > 0 ? "de más" : "de menos";

  return `hereda ${declared} de coste y del origen salen ${derived}: ${delta} ${direction}`;
}

function legWord(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
