/**
 * Deterministic seam for importing balance history as a chain of re-baselines
 * (ADR 0056, #696). Consumed by #764 S5 assistant — no UI of its own.
 *
 * Validates each row, computes drift vs the vigente curve at that date, and
 * composes the chained re-baselines the store seam persists atomically with
 * ONE ripple.
 */

import { ISO_DATE } from "@web/intake-primitives";
import type {
  AmortizationPlanInput,
  BalanceRebaselineInput,
  DecimalString,
} from "@worthline/domain";
import { debtBalanceAtDate, effectiveAmortizationPlan } from "@worthline/domain";

import {
  deriveRecalibrationRebaseline,
  PRE_ORIGIN_BALANCE_DATE_MESSAGE,
  type RecalibrationRevision,
} from "./recalibrate-debt";

export interface BalanceHistoryRowInput {
  /** Fecha del saldo, YYYY-MM-DD. */
  date: string;
  /** Saldo declarado, integer minor units. */
  balanceMinor: number;
  /** Tipo de interés anual opcional — overrides composed rate when present. */
  annualRate?: DecimalString;
}

export type BalanceHistoryRowStatus = "accepted" | "excluded" | "skipped";

export interface BalanceHistoryRowPreview {
  date: string;
  balanceMinor: number;
  annualRate?: DecimalString;
  status: BalanceHistoryRowStatus;
  reason?: string;
  /** Declared minus modelled balance at this date; null when not computable. */
  driftMinor: number | null;
}

export interface BalanceHistoryDebtContext {
  plan?: AmortizationPlanInput;
  balanceRebaselines: readonly BalanceRebaselineInput[];
  revisions: readonly RecalibrationRevision[];
  currentBalanceMinor: number;
  today: string;
}

export type ComposedBalanceHistoryRebaseline = Omit<
  BalanceRebaselineInput,
  "startsAtBaseline"
>;

export interface BalanceHistoryImportPlan {
  previews: BalanceHistoryRowPreview[];
  composed: ComposedBalanceHistoryRebaseline[];
}

/** Spanish messages reusable by the #764 assistant preview surface. */
export const BALANCE_HISTORY_MESSAGES = {
  duplicateDate: "Ya existe un saldo en esta fecha.",
  duplicateInBatch: "Fecha duplicada en la serie.",
  futureDate: "La fecha del saldo no puede ser futura.",
  invalidDate: "La fecha del saldo no es válida.",
  invalidSeries: "La serie de saldos no es válida.",
  nonPositiveBalance: "Introduce un saldo real mayor que 0 €.",
  preOrigin: PRE_ORIGIN_BALANCE_DATE_MESSAGE,
} as const;

export type ParseBalanceHistoryRowsResult =
  | { ok: true; rows: BalanceHistoryRowInput[] }
  | { ok: false; error: string };

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function isValidIsoDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Validate external row payloads at the action boundary — every element must
 * carry a real ISO date and a positive integer balanceMinor.
 */
export function parseBalanceHistoryRows(raw: unknown): ParseBalanceHistoryRowsResult {
  if (!Array.isArray(raw)) {
    return { error: BALANCE_HISTORY_MESSAGES.invalidSeries, ok: false };
  }

  const rows: BalanceHistoryRowInput[] = [];
  for (const element of raw) {
    if (element === null || typeof element !== "object") {
      return { error: BALANCE_HISTORY_MESSAGES.invalidSeries, ok: false };
    }

    const record = element as Record<string, unknown>;
    if (typeof record.date !== "string") {
      return { error: BALANCE_HISTORY_MESSAGES.invalidSeries, ok: false };
    }

    const balanceMinor = record.balanceMinor;
    if (
      typeof balanceMinor !== "number" ||
      !Number.isInteger(balanceMinor) ||
      balanceMinor <= 0
    ) {
      return { error: BALANCE_HISTORY_MESSAGES.invalidSeries, ok: false };
    }

    let annualRate: DecimalString | undefined;
    if (record.annualRate !== undefined) {
      if (
        typeof record.annualRate !== "string" ||
        !DECIMAL_STRING.test(record.annualRate)
      ) {
        return { error: BALANCE_HISTORY_MESSAGES.invalidSeries, ok: false };
      }
      annualRate = record.annualRate;
    }

    rows.push({
      balanceMinor,
      date: record.date,
      ...(annualRate !== undefined ? { annualRate } : {}),
    });
  }

  return { ok: true, rows };
}

function validateRowBasics(
  row: BalanceHistoryRowInput,
  today: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidIsoDate(row.date)) {
    return { ok: false, reason: BALANCE_HISTORY_MESSAGES.invalidDate };
  }
  if (row.date > today) {
    return { ok: false, reason: BALANCE_HISTORY_MESSAGES.futureDate };
  }
  if (row.balanceMinor <= 0) {
    return { ok: false, reason: BALANCE_HISTORY_MESSAGES.nonPositiveBalance };
  }
  return { ok: true };
}

function previewRow(
  row: BalanceHistoryRowInput,
  fields: Omit<BalanceHistoryRowPreview, "balanceMinor" | "date" | "annualRate">,
): BalanceHistoryRowPreview {
  return {
    balanceMinor: row.balanceMinor,
    date: row.date,
    ...(row.annualRate !== undefined ? { annualRate: row.annualRate } : {}),
    ...fields,
  };
}

function effectiveAt(
  ctx: BalanceHistoryDebtContext,
  balanceRebaselines: readonly BalanceRebaselineInput[],
  targetDate: string,
) {
  return effectiveAmortizationPlan({
    balanceRebaselines,
    ...(ctx.plan ? { plan: ctx.plan } : {}),
    targetDate,
  });
}

function vigenteBalanceAt(ctx: BalanceHistoryDebtContext, targetDate: string): number {
  return debtBalanceAtDate({
    balanceRebaselines: ctx.balanceRebaselines,
    currentBalanceMinor: ctx.currentBalanceMinor,
    debtModel: "amortizable",
    ...(ctx.plan ? { plan: ctx.plan } : {}),
    revisions: ctx.revisions,
    targetDate,
  });
}

function derivationReason(error: string): string {
  return error === PRE_ORIGIN_BALANCE_DATE_MESSAGE
    ? BALANCE_HISTORY_MESSAGES.preOrigin
    : error;
}

/**
 * Single pass: preview every row (drift vs the vigente curve) and compose the
 * chained re-baselines accepted rows will persist.
 */
export function planBalanceHistoryImport(
  rows: readonly BalanceHistoryRowInput[],
  ctx: BalanceHistoryDebtContext,
): BalanceHistoryImportPlan {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const previews: BalanceHistoryRowPreview[] = [];
  const composed: ComposedBalanceHistoryRebaseline[] = [];
  const seenDates = new Set<string>();
  const chainRebaselines: BalanceRebaselineInput[] = [...ctx.balanceRebaselines];

  for (const row of sorted) {
    const basics = validateRowBasics(row, ctx.today);
    if (!basics.ok) {
      previews.push(
        previewRow(row, {
          driftMinor: null,
          reason: basics.reason,
          status: "excluded",
        }),
      );
      continue;
    }

    if (seenDates.has(row.date)) {
      previews.push(
        previewRow(row, {
          driftMinor: null,
          reason: BALANCE_HISTORY_MESSAGES.duplicateInBatch,
          status: "excluded",
        }),
      );
      continue;
    }
    seenDates.add(row.date);

    const existing = ctx.balanceRebaselines.find((r) => r.baselineDate === row.date);
    if (existing) {
      if (existing.outstandingBalanceMinor === row.balanceMinor) {
        previews.push(
          previewRow(row, {
            driftMinor: 0,
            status: "skipped",
          }),
        );
        continue;
      }
      previews.push(
        previewRow(row, {
          driftMinor: null,
          reason: BALANCE_HISTORY_MESSAGES.duplicateDate,
          status: "excluded",
        }),
      );
      continue;
    }

    const effective = effectiveAt(ctx, chainRebaselines, row.date);
    const derived = deriveRecalibrationRebaseline({
      balanceDate: row.date,
      effective,
      revisions: ctx.revisions,
    });

    if (!derived.ok) {
      previews.push(
        previewRow(row, {
          driftMinor: null,
          reason: derivationReason(derived.error),
          status: "excluded",
        }),
      );
      continue;
    }

    const driftMinor = row.balanceMinor - vigenteBalanceAt(ctx, row.date);

    const next: ComposedBalanceHistoryRebaseline = {
      annualInterestRate: row.annualRate ?? derived.annualInterestRate,
      baselineDate: row.date,
      endDate: derived.endDate,
      nextPaymentDate: derived.nextPaymentDate,
      outstandingBalanceMinor: row.balanceMinor,
    };
    composed.push(next);

    previews.push(
      previewRow(row, {
        driftMinor,
        status: "accepted",
      }),
    );

    chainRebaselines.push({
      ...next,
      startsAtBaseline: false,
    });
  }

  return { composed, previews };
}

/** Preview-only view of {@link planBalanceHistoryImport}. */
export function previewBalanceHistoryImport(
  rows: readonly BalanceHistoryRowInput[],
  ctx: BalanceHistoryDebtContext,
): BalanceHistoryRowPreview[] {
  return planBalanceHistoryImport(rows, ctx).previews;
}

/** Compose-only view — prefer {@link planBalanceHistoryImport} to avoid a second pass. */
export function composeBalanceHistoryRebaselines(
  previews: readonly BalanceHistoryRowPreview[],
  ctx: BalanceHistoryDebtContext,
): ComposedBalanceHistoryRebaseline[] {
  const acceptedDates = new Set(
    previews.filter((row) => row.status === "accepted").map((row) => row.date),
  );
  return planBalanceHistoryImport(
    previews
      .filter((row) => acceptedDates.has(row.date))
      .map((row) => ({
        balanceMinor: row.balanceMinor,
        date: row.date,
        ...(row.annualRate !== undefined ? { annualRate: row.annualRate } : {}),
      })),
    ctx,
  ).composed;
}
