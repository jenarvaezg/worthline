/**
 * The primitives every proposal parser is built from (#1609).
 *
 * A `propose_*` tool answer reaches the card as `unknown`: it crossed the model
 * stream, and a tab open since before a deploy carries the shape of the version it
 * loaded with. Before this module each parser checked a handful of fields and then
 * said `raw as unknown as XProposal` — a promise nobody kept. A payload missing a
 * field the card DEREFERENCES passed the typechecker and threw while painting.
 *
 * So no parser here asserts: each one BUILDS the domain value from checked parts, or
 * returns `null` and the card is simply absent (the draft survives, and the next turn
 * rebuilds it). Since the value is built, the compiler is the one checking that every
 * field of the contract is present — which is the whole point: the kind closes the
 * type.
 *
 * Two conventions hold everywhere:
 * - `parse*` returns the value or `null`; `is*` narrows in place.
 * - Optional fields are spread in conditionally (`...(x === undefined ? {} : { x })`),
 *   because `exactOptionalPropertyTypes` tells an absent key apart from an explicit
 *   `undefined`, and the contracts mean the first.
 */

import type {
  BalanceReconciliation,
  BalanceReconciliationStatus,
  BalanceWitness,
} from "@web/asistente/balance-reconciliation";
import type {
  FundMatchChoice,
  FundPositionImpact,
  FundPreviewRow,
  IsinLookupResult,
  PositionImpactFlag,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import type { DebtSnapshotMembership } from "@worthline/domain";
import { INVESTMENT_PRICE_PROVIDERS } from "@worthline/domain";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A money field that is `null` when the read degraded (ADR 0048). `null` is NOT a
 * real 0 €: the cards say "impacto no disponible" rather than fabricate a total.
 */
export function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

export function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** Narrows a string to one of a closed vocabulary — how every union field is read. */
export function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * Every element or nothing: one bad row rejects the whole list, because a card that
 * renders half a batch is a card that misstates what confirming would do.
 */
export function parseAll<T>(
  raw: unknown,
  parseItem: (value: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(raw)) return null;
  const items: T[] = [];
  for (const entry of raw) {
    const item = parseItem(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

export function parseStrings(raw: unknown): string[] | null {
  return parseAll(raw, (value) => (typeof value === "string" ? value : null));
}

/** The before → after → delta triple the impact headers render. */
export interface NetWorthImpact {
  beforeMinor: number | null;
  afterMinor: number | null;
  deltaMinor: number;
}

export function parseNetWorthImpact(raw: unknown): NetWorthImpact | null {
  if (!isRecord(raw)) return null;
  const { afterMinor, beforeMinor, deltaMinor } = raw;
  if (!isNullableNumber(beforeMinor) || !isNullableNumber(afterMinor)) return null;
  if (typeof deltaMinor !== "number") return null;
  return { afterMinor, beforeMinor, deltaMinor };
}

/** The `{ id, name }` echo every contract keeps of the holding it targets. */
export function parseNamedRef(raw: unknown): { id: string; name: string } | null {
  if (!isRecord(raw)) return null;
  const { id, name } = raw;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, name };
}

/** One `label · antes → después` line, already rendered es-ES by the server. */
export function parseBeforeAfterRow(
  raw: unknown,
): { label: string; before: string; after: string } | null {
  if (!isRecord(raw)) return null;
  const { after, before, label } = raw;
  if (typeof label !== "string" || typeof before !== "string") return null;
  if (typeof after !== "string") return null;
  return { after, before, label };
}

export function parseBalanceCurvePoint(
  raw: unknown,
): { date: string; balanceMinor: number } | null {
  if (!isRecord(raw)) return null;
  const { balanceMinor, date } = raw;
  if (typeof date !== "string" || typeof balanceMinor !== "number") return null;
  return { balanceMinor, date };
}

export function parseValueCurvePoint(
  raw: unknown,
): { date: string; valueMinor: number } | null {
  if (!isRecord(raw)) return null;
  const { date, valueMinor } = raw;
  if (typeof date !== "string" || typeof valueMinor !== "number") return null;
  return { date, valueMinor };
}

/**
 * One declared point of a debt's balance history: what the document says, how far it
 * drifts from the modelled curve, and whether it will apply. Shared by the balance
 * history lane and the debt segment of a mixed document — one shape, one reading.
 */
export interface DebtHistoryPoint {
  date: string;
  balanceMinor: number;
  driftMinor: number | null;
  status: "accepted" | "excluded" | "skipped";
  reason?: string;
}

const HISTORY_POINT_STATUSES: readonly DebtHistoryPoint["status"][] = [
  "accepted",
  "excluded",
  "skipped",
];

export function parseDebtHistoryPoint(raw: unknown): DebtHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const { balanceMinor, date, driftMinor, reason, status } = raw;
  if (typeof date !== "string" || typeof balanceMinor !== "number") return null;
  if (!isNullableNumber(driftMinor) || !isOneOf(status, HISTORY_POINT_STATUSES)) {
    return null;
  }
  if (!isOptionalString(reason)) return null;
  return {
    balanceMinor,
    date,
    driftMinor,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

const RECONCILIATION_STATUSES: readonly BalanceReconciliationStatus[] = [
  "exact",
  "within-tolerance",
  "mismatch",
];

const WITNESSES: readonly BalanceWitness[] = ["declared", "model"];

/**
 * The three-witness verdict (#1422). Every field is checked, `anchor` included,
 * because the cards DEREFERENCE `reconciliation.anchor.stale` at render: half a
 * verdict is not half a guarantee, it is an exception.
 */
export function parseBalanceReconciliation(raw: unknown): BalanceReconciliation | null {
  if (!isRecord(raw)) return null;
  const {
    against,
    anchor,
    deltaMinor,
    expectedMinor,
    matches,
    resultingMinor,
    status,
    toleranceMinor,
  } = raw;
  if (!isOneOf(status, RECONCILIATION_STATUSES) || !isOneOf(against, WITNESSES)) {
    return null;
  }
  if (typeof matches !== "boolean") return null;
  if (
    typeof expectedMinor !== "number" ||
    typeof resultingMinor !== "number" ||
    typeof deltaMinor !== "number" ||
    typeof toleranceMinor !== "number"
  ) {
    return null;
  }
  if (!isRecord(anchor)) return null;
  const { declaredMinor, driftMinor, modelMinor, stale } = anchor;
  if (
    typeof declaredMinor !== "number" ||
    typeof modelMinor !== "number" ||
    typeof driftMinor !== "number" ||
    typeof stale !== "boolean"
  ) {
    return null;
  }
  return {
    against,
    anchor: { declaredMinor, driftMinor, modelMinor, stale },
    deltaMinor,
    expectedMinor,
    matches,
    resultingMinor,
    status,
    toleranceMinor,
  };
}

/**
 * The ripple-membership preflight (#1438). Absent in a payload built before it
 * existed, and the cards already read it as optional — a missing membership warns
 * about nothing and blocks nothing, which is why losing the whole card over it
 * would be the harsher answer.
 */
export function parseSnapshotMembership(raw: unknown): DebtSnapshotMembership | null {
  if (!isRecord(raw)) return null;
  const { missing, startDate, total } = raw;
  if (typeof total !== "number" || typeof missing !== "number") return null;
  if (!isOptionalString(startDate)) return null;
  return { missing, total, ...(startDate === undefined ? {} : { startDate }) };
}

const IMPACT_FLAGS: readonly PositionImpactFlag[] = [
  "nearly_doubles",
  "oversell",
  "near_zero",
];

export function parsePositionImpact(raw: unknown): FundPositionImpact | null {
  if (!isRecord(raw)) return null;
  const { afterUnits, afterValueMinor, beforeUnits, beforeValueMinor, flags } = raw;
  if (typeof beforeUnits !== "string" || typeof afterUnits !== "string") return null;
  if (typeof beforeValueMinor !== "number" || typeof afterValueMinor !== "number") {
    return null;
  }
  const parsedFlags = parseAll(flags, (flag) =>
    isOneOf(flag, IMPACT_FLAGS) ? flag : null,
  );
  if (parsedFlags === null) return null;
  return {
    afterUnits,
    afterValueMinor,
    beforeUnits,
    beforeValueMinor,
    flags: parsedFlags,
  };
}

function parseIsinLookup(raw: unknown): IsinLookupResult | null {
  if (!isRecord(raw)) return null;
  if (raw.status === "not_found") return { status: "not_found" };
  if (raw.status === "error") return { status: "error" };
  if (raw.status !== "found") return null;
  const { name, provider, symbol } = raw;
  if (typeof name !== "string" || typeof symbol !== "string") return null;
  if (!isOneOf(provider, INVESTMENT_PRICE_PROVIDERS)) return null;
  return { name, provider, status: "found", symbol };
}

function parseFundMatchChoice(raw: unknown): FundMatchChoice | null {
  if (!isRecord(raw)) return null;
  const {
    assetId,
    closed,
    existingName,
    openingKeptPositionImpact,
    positionImpact,
    toCreateCount,
    toDeleteCount,
    toOverwriteCount,
  } = raw;
  if (typeof assetId !== "string" || typeof existingName !== "string") return null;
  if (typeof closed !== "boolean") return null;
  if (
    typeof toCreateCount !== "number" ||
    typeof toDeleteCount !== "number" ||
    typeof toOverwriteCount !== "number"
  ) {
    return null;
  }
  const impact = parsePositionImpact(positionImpact);
  if (impact === null) return null;
  const keptImpact =
    openingKeptPositionImpact === undefined
      ? undefined
      : parsePositionImpact(openingKeptPositionImpact);
  if (keptImpact === null) return null;
  return {
    assetId,
    closed,
    existingName,
    positionImpact: impact,
    toCreateCount,
    toDeleteCount,
    toOverwriteCount,
    ...(keptImpact === undefined ? {} : { openingKeptPositionImpact: keptImpact }),
  };
}

/**
 * One fund row of a statement preview — a discriminated union on `bucket`: a
 * `matched` row carries the ledger it would rewrite (and every claimant of an
 * ambiguous identifier, #1366), a `new` one the identity it would be created with.
 */
export function parseFundPreviewRow(raw: unknown): FundPreviewRow | null {
  if (!isRecord(raw)) return null;
  const { amountMinor, executedCount, isin, positionImpact, skippedCount } = raw;
  if (typeof isin !== "string") return null;
  if (
    typeof executedCount !== "number" ||
    typeof skippedCount !== "number" ||
    typeof amountMinor !== "number"
  ) {
    return null;
  }
  const impact = parsePositionImpact(positionImpact);
  if (impact === null) return null;
  const common = {
    amountMinor,
    executedCount,
    isin,
    positionImpact: impact,
    skippedCount,
  };

  if (raw.bucket === "matched") {
    const {
      ambiguous,
      assetId,
      choices,
      existingName,
      openingKeptPositionImpact,
      toCreateCount,
      toDeleteCount,
      toOverwriteCount,
    } = raw;
    if (typeof assetId !== "string" || typeof existingName !== "string") return null;
    if (
      typeof toCreateCount !== "number" ||
      typeof toDeleteCount !== "number" ||
      typeof toOverwriteCount !== "number" ||
      typeof ambiguous !== "boolean"
    ) {
      return null;
    }
    const parsedChoices = parseAll(choices, parseFundMatchChoice);
    if (parsedChoices === null) return null;
    const keptImpact =
      openingKeptPositionImpact === undefined
        ? undefined
        : parsePositionImpact(openingKeptPositionImpact);
    if (keptImpact === null) return null;
    return {
      ...common,
      ambiguous,
      assetId,
      bucket: "matched",
      choices: parsedChoices,
      existingName,
      toCreateCount,
      toDeleteCount,
      toOverwriteCount,
      ...(keptImpact === undefined ? {} : { openingKeptPositionImpact: keptImpact }),
    };
  }

  if (raw.bucket !== "new") return null;
  const { lookup, suggestedName, suggestedSymbol } = raw;
  if (typeof suggestedName !== "string" || typeof suggestedSymbol !== "string") {
    return null;
  }
  const parsedLookup = parseIsinLookup(lookup);
  if (parsedLookup === null) return null;
  return {
    ...common,
    bucket: "new",
    lookup: parsedLookup,
    suggestedName,
    suggestedSymbol,
  };
}
