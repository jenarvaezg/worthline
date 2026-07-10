/**
 * Deterministic seam for importing balance history as a chain of re-baselines
 * (ADR 0056, #696). Consumed by #764 S5 assistant — no UI of its own.
 *
 * Validates each row, computes drift vs the curve at that date, and composes
 * the chained re-baselines the store seam persists atomically with ONE ripple.
 */

import type {
  AmortizationPlanInput,
  BalanceRebaselineInput,
  DecimalString,
} from "@worthline/domain";
import { debtBalanceAtDate, effectiveAmortizationPlan } from "@worthline/domain";

import {
  deriveRecalibrationRebaseline,
  type RecalibrationRevision,
} from "./recalibrate-debt";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

export interface ComposedBalanceHistoryRebaseline {
  baselineDate: string;
  outstandingBalanceMinor: number;
  annualInterestRate: DecimalString;
  endDate: string;
  nextPaymentDate: string;
}

/** Spanish messages reusable by the #764 assistant preview surface. */
export const BALANCE_HISTORY_MESSAGES = {
  duplicateDate: "Ya existe un saldo en esta fecha.",
  duplicateInBatch: "Fecha duplicada en la serie.",
  futureDate: "La fecha del saldo no puede ser futura.",
  invalidDate: "La fecha del saldo no es válida.",
  nonPositiveBalance: "Introduce un saldo real mayor que 0 €.",
  preOrigin: "La fecha del saldo no puede ser anterior al inicio de esta deuda.",
} as const;

function isValidIsoDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
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

function modelledBalanceAt(
  ctx: BalanceHistoryDebtContext,
  targetDate: string,
  extraRebaselines: readonly BalanceRebaselineInput[],
): number {
  return debtBalanceAtDate({
    balanceRebaselines: [...ctx.balanceRebaselines, ...extraRebaselines],
    currentBalanceMinor: ctx.currentBalanceMinor,
    debtModel: "amortizable",
    ...(ctx.plan ? { plan: ctx.plan } : {}),
    revisions: ctx.revisions,
    targetDate,
  });
}

/**
 * Validate and preview every row: exclusion reasons in Spanish, drift per row
 * vs the curve that includes prior accepted rows in the batch (chained).
 */
export function previewBalanceHistoryImport(
  rows: readonly BalanceHistoryRowInput[],
  ctx: BalanceHistoryDebtContext,
): BalanceHistoryRowPreview[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const previews: BalanceHistoryRowPreview[] = [];
  const seenDates = new Set<string>();
  const acceptedInBatch: BalanceRebaselineInput[] = [];

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

    const effective = effectiveAt(
      ctx,
      [...ctx.balanceRebaselines, ...acceptedInBatch],
      row.date,
    );

    const derived = deriveRecalibrationRebaseline({
      balanceDate: row.date,
      effective,
      revisions: ctx.revisions,
    });

    if (!derived.ok) {
      previews.push(
        previewRow(row, {
          driftMinor: null,
          reason: derived.error,
          status: "excluded",
        }),
      );
      continue;
    }

    const modelled = modelledBalanceAt(ctx, row.date, acceptedInBatch);
    const driftMinor = row.balanceMinor - modelled;

    previews.push(
      previewRow(row, {
        driftMinor,
        status: "accepted",
      }),
    );

    acceptedInBatch.push({
      annualInterestRate: row.annualRate ?? derived.annualInterestRate,
      baselineDate: row.date,
      endDate: derived.endDate,
      nextPaymentDate: derived.nextPaymentDate,
      outstandingBalanceMinor: row.balanceMinor,
      startsAtBaseline: false,
    });
  }

  return previews;
}

/** Compose the persisted re-baseline chain from accepted preview rows. */
export function composeBalanceHistoryRebaselines(
  previews: readonly BalanceHistoryRowPreview[],
  ctx: BalanceHistoryDebtContext,
): ComposedBalanceHistoryRebaseline[] {
  const accepted = previews.filter((p) => p.status === "accepted");
  const sorted = [...accepted].sort((a, b) => a.date.localeCompare(b.date));
  const result: ComposedBalanceHistoryRebaseline[] = [];
  const chainRebaselines: BalanceRebaselineInput[] = [...ctx.balanceRebaselines];

  for (const row of sorted) {
    const effective = effectiveAt(ctx, chainRebaselines, row.date);

    const derived = deriveRecalibrationRebaseline({
      balanceDate: row.date,
      effective,
      revisions: ctx.revisions,
    });

    if (!derived.ok) continue;

    const composed: ComposedBalanceHistoryRebaseline = {
      annualInterestRate: row.annualRate ?? derived.annualInterestRate,
      baselineDate: row.date,
      endDate: derived.endDate,
      nextPaymentDate: derived.nextPaymentDate,
      outstandingBalanceMinor: row.balanceMinor,
    };
    result.push(composed);

    chainRebaselines.push({
      ...composed,
      startsAtBaseline: false,
    });
  }

  return result;
}
