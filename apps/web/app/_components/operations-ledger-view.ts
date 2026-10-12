/**
 * How the ficha's operations ledger reads (#1827): one row per apunte, compact, with
 * its importe; the 10 latest on show and the rest one click away.
 *
 * Pure (interaction-patterns §7) so the reading and the «Ver las N» rule unit-test in
 * the node env while `OperationsLedger` stays a thin shell. The importe is the
 * domain's (`operationAmountMinor`); this module only parses what the row holds and
 * formats what comes back.
 */

import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import {
  operationKindLabel,
  type TransferRowCounterpart,
  transferRowNote,
} from "@web/operation-kind-copy";
import { readViewParam, type ViewParamSpec, writeViewParam } from "@web/view-state";
import {
  formatUnits,
  type InvestmentOperation,
  isTransferKind,
  operationAmountMinor,
} from "@worthline/domain";
import {
  readDocumentMoney,
  readOperationFees,
  readOperationPrice,
} from "./operation-capture-reading";

/** How many apuntes the ledger shows before «Ver las N operaciones». */
export const LEDGER_RECENT_LIMIT = 10;

/** The ledger folded to its latest rows, or unfolded. */
export type LedgerScope = "recientes" | "todas";

/**
 * Whether the ledger is unfolded lives in the URL (`?libro=todas`, interaction-patterns
 * §3), not beside it: the delete's terminal redirects and remounts the ledger (§4.1), so
 * a fold held in component state snapped shut after every delete — exactly when the
 * person was working through the older rows. The folded ledger is the clean URL.
 */
export const LEDGER_VIEW_PARAM: ViewParamSpec<LedgerScope> = {
  allowed: ["recientes", "todas"],
  fallback: "recientes",
  key: "libro",
};

/** The scope a query string (`"?a=b"` or `"a=b"`) asks for. */
export function readLedgerScope(search: string): LedgerScope {
  return readViewParam(search, LEDGER_VIEW_PARAM);
}

/**
 * The `currentUrl` a row's delete posts: the ficha it came from, carrying the scope,
 * so its terminal lands on the ledger as the person left it. Every other param stays.
 */
export function ledgerReturnUrl(currentUrl: string, scope: LedgerScope): string {
  const queryAt = currentUrl.indexOf("?");
  const path = queryAt === -1 ? currentUrl : currentUrl.slice(0, queryAt);
  const search = queryAt === -1 ? "" : currentUrl.slice(queryAt);
  return `${path}${writeViewParam(search, LEDGER_VIEW_PARAM, scope)}`;
}

/** One ledger row, every figure already in the words the screen prints. */
export interface LedgerRowReading {
  id: string;
  date: string;
  kind: string;
  /** The traspaso half's origin/destination and inherited cost (#1481), or null. */
  note: string | null;
  isTransfer: boolean;
  units: string;
  price: string;
  /** The unit price as the bank stated it in another currency (#1401), or null. */
  priceCapture: string | null;
  /** Null when the apunte had no fees. */
  fees: string | null;
  feesCapture: string | null;
  /** The domain's importe, or «—» when the row's figures cannot be read. */
  amount: string;
  /** The phone's second line: «5 × 106,65 € · comisión 1 €». */
  calc: string;
}

/**
 * The importe of a row, or null when its figures are not numbers yet.
 *
 * A settled row holds canonical decimals; the optimistic one the record form adds
 * before its action resolves holds what was TYPED («105,50»). Both go through the
 * es-ES normalization the server's operation parser applies (comma decimals, dots as
 * thousands only beside a comma), so the optimistic row shows the importe the server
 * is about to write — in the currency it was typed in, which the money formatter
 * names, so dollars never pass for euros (#1401). A negative or unreadable figure is
 * one the server refuses: no importe, rather than an invented one.
 */
function readAmount(operation: InvestmentOperation, privacyMode: boolean): string | null {
  const units = normalizeNonNegativeDecimalString(operation.units);
  const pricePerUnit = normalizeNonNegativeDecimalString(operation.pricePerUnit);
  if (units === null || pricePerUnit === null) return null;

  const amountMinor = operationAmountMinor({
    feesMinor: operation.feesMinor,
    kind: operation.kind,
    pricePerUnit,
    units,
  });
  return readDocumentMoney({ amountMinor, currency: operation.currency }, privacyMode);
}

export function readLedgerRow(
  operation: InvestmentOperation,
  {
    counterpart,
    privacyMode,
  }: {
    /** Where the traspaso half's other half lives (#1481); `unresolved` claims nothing. */
    counterpart: TransferRowCounterpart;
    privacyMode: boolean;
  },
): LedgerRowReading {
  const price = readOperationPrice(operation, privacyMode);
  const feesReading = readOperationFees(operation, privacyMode);
  const fees = feesReading ? readDocumentMoney(feesReading.fees, privacyMode) : null;
  const units = formatUnits(operation.units);

  // The captured figures ride beside the euros they became, so the phone's one line
  // still says what the bank stated (#1401).
  const priced = `${price.price}${price.capture ? ` (${price.capture})` : ""}`;
  const charged =
    fees === null
      ? ""
      : ` · comisión ${fees}${feesReading?.capture ? ` (${feesReading.capture})` : ""}`;

  return {
    amount: readAmount(operation, privacyMode) ?? "—",
    calc: `${units} × ${priced}${charged}`,
    date: formatIsoDayEs(operation.executedAt),
    fees,
    feesCapture: feesReading?.capture ?? null,
    id: operation.id,
    isTransfer: isTransferKind(operation.kind),
    kind: operationKindLabel(operation.kind),
    // The traspaso half reads as one move with an origin and a destination (#1481) —
    // never as a loose sale or buy.
    note: transferRowNote({
      counterpart,
      kind: operation.kind,
      privacyMode,
      ...(operation.transferCostMinor !== undefined
        ? { transferCostMinor: operation.transferCostMinor }
        : {}),
      // The declared inherited seniority (#1518). Shown so it can be CHECKED: nothing
      // computes on it yet, and a year typed wrong that nobody can see is one nobody
      // can correct.
      ...(operation.transferSeniorityAt !== undefined
        ? { transferSeniorityAt: operation.transferSeniorityAt }
        : {}),
    }),
    price: price.price,
    priceCapture: price.capture,
    units,
  };
}

/** The «Ver las N» control: absent when everything is already on show. */
export interface LedgerToggle {
  expanded: boolean;
  label: string;
}

/**
 * Which rows are on show (#1827): the {@link LEDGER_RECENT_LIMIT} latest, or all of
 * them once expanded. `rows` come newest first.
 *
 * A row that `isFresh` — the one just recorded (#1829) — shows even when it sorts past
 * the tenth, as a backdated buy does: «after recording, the new row is on show» is a
 * promise the collapsed ledger must not break. It shows in its own place, and the
 * control still counts every row.
 */
export function ledgerRowsOnShow<T>(
  rows: readonly T[],
  expanded: boolean,
  isFresh: (row: T) => boolean = () => false,
): { shown: readonly T[]; toggle: LedgerToggle | null } {
  if (rows.length <= LEDGER_RECENT_LIMIT) {
    return { shown: rows, toggle: null };
  }

  if (expanded) {
    return {
      shown: rows,
      toggle: { expanded: true, label: `Ver solo las ${LEDGER_RECENT_LIMIT} últimas` },
    };
  }

  return {
    shown: rows.filter((row, index) => index < LEDGER_RECENT_LIMIT || isFresh(row)),
    toggle: { expanded: false, label: `Ver las ${rows.length} operaciones` },
  };
}
