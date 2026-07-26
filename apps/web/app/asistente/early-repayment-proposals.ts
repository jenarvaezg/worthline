/**
 * Early-repayment proposal builder (#1245, PRD #1241). Closes the repair gap the
 * PRD names: the domain already models an `EarlyRepayment` — mode, month boundary,
 * curve and ripple — and the UI already edits one, but the assistant could only
 * offer `declare_balance`, which re-baselines from today and LOSES THE CAUSE. This
 * registers the cause instead: a dated lump against one amortizable debt.
 *
 * It writes NOTHING. It reads the debt's live schedule, asks the domain what the
 * repayment would really do ({@link projectEarlyRepaymentImpact}), persists the
 * fact as a draft proposal, and returns the preview. The confirm action applies it.
 */

import { createHash } from "node:crypto";
import type {
  AssistantProposal,
  AssistantProposalStore,
  EarlyRepaymentPlan,
  WorthlineStore,
} from "@worthline/db";
import type { EarlyRepaymentMode } from "@worthline/domain";
import {
  type EarlyRepaymentImpact,
  formatDayEs,
  projectEarlyRepaymentImpact,
} from "./early-repayment-impact";
import {
  EARLY_REPAYMENT_FOLIO,
  type EarlyRepaymentProposal,
  earlyRepaymentModeLabel,
} from "./early-repayment-proposal-contract";
import { boundProposalSummary } from "./proposal-summary";

type ProposalStore = Pick<WorthlineStore, "liabilities"> & {
  assistantProposals: AssistantProposalStore;
};
type LiabilityReads = Pick<WorthlineStore, "liabilities">;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES: readonly EarlyRepaymentMode[] = ["reduce-payment", "reduce-term"];

/** The route offered when the debt has no amortization schedule to reshape. */
const NO_SCHEDULE_ROUTE =
  "Esta deuda es revolving/informal: no tiene cuadro de amortización, así que una " +
  "anticipada no tiene curva sobre la que aplicarse. Declara su saldo real con " +
  "propose_correction (declare_balance), que en este modelo escribe un balance anchor.";

export interface EarlyRepaymentArgs {
  /** Internal liability id, already resolved from the public `wl_hld_…`. */
  liabilityId: string;
  /** The `wl_hld_…` echoed back to the card. */
  publicHoldingId: string;
  repaymentDate: string;
  amountMinor: number;
  mode: EarlyRepaymentMode;
  observedMonthlyPaymentMinor?: number;
  summary?: string;
}

export interface ParsedEarlyRepayment {
  liabilityId: string;
  repaymentDate: string;
  amountMinor: number;
  mode: EarlyRepaymentMode;
  observedMonthlyPaymentMinor?: number;
  summary?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Cents-precise es-ES euros — see the note in `early-repayment-impact.ts`. */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("es-ES", {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

/**
 * The trust boundary for the model's arguments. Money is integer minor units and
 * a non-integer is REJECTED, never rounded: the attachment contract speaks major
 * units (91,32 €), so `91.32` arriving here is the euros-for-cents mistake, and
 * silently rounding it to 91 cents would write a figure nobody read. The mode is
 * likewise never inferred — an absent one means the agent must ask.
 */
export function parseEarlyRepaymentInput(raw: unknown, today: string) {
  if (!isRecord(raw)) {
    return { ok: false as const, error: "Falta una amortización anticipada válida." };
  }
  if (typeof raw.liabilityId !== "string" || !raw.liabilityId.trim()) {
    return {
      ok: false as const,
      error: "Falta la deuda a la que aplicar la anticipada.",
    };
  }
  if (!isCalendarDate(raw.repaymentDate)) {
    return {
      ok: false as const,
      error: "Falta la fecha de la anticipada (YYYY-MM-DD) o no es una fecha real.",
    };
  }
  if (raw.repaymentDate > today) {
    return {
      ok: false as const,
      error: "Una anticipada observada no puede tener fecha futura.",
    };
  }
  if (!Number.isSafeInteger(raw.amountMinor) || (raw.amountMinor as number) <= 0) {
    return {
      ok: false as const,
      error:
        "El importe de la anticipada va en CÉNTIMOS enteros y positivos (91,32 € son 9132). No redondeo un importe con decimales: comprueba la cifra.",
    };
  }
  if (
    raw.observedMonthlyPaymentMinor !== undefined &&
    (!Number.isSafeInteger(raw.observedMonthlyPaymentMinor) ||
      (raw.observedMonthlyPaymentMinor as number) <= 0)
  ) {
    return {
      ok: false as const,
      error:
        "La cuota observada va en CÉNTIMOS enteros y positivos (158,49 € son 15849). No redondeo un importe con decimales.",
    };
  }
  if (typeof raw.mode !== "string" || !MODES.includes(raw.mode as EarlyRepaymentMode)) {
    return {
      ok: false as const,
      error:
        "Falta el modo de la anticipada: reduce-term (misma cuota, acaba antes) o reduce-payment (mismo plazo, cuota más baja). Si la pantalla no lo dice, pregúntaselo al usuario en vez de elegir por él.",
    };
  }
  return {
    ok: true as const,
    row: {
      amountMinor: raw.amountMinor as number,
      liabilityId: raw.liabilityId.trim(),
      mode: raw.mode as EarlyRepaymentMode,
      repaymentDate: raw.repaymentDate,
      ...(raw.observedMonthlyPaymentMinor === undefined
        ? {}
        : { observedMonthlyPaymentMinor: raw.observedMonthlyPaymentMinor as number }),
      ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
    } satisfies ParsedEarlyRepayment,
  };
}

/** The single early-repayment plan an `early_repayment` proposal carries. */
export function earlyRepaymentPlanFromProposal(
  proposal: AssistantProposal,
): EarlyRepaymentPlan | null {
  if (proposal.kind !== "early_repayment") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "debt_early_repayment");
  return facts.length === 1 ? facts[0]!.row : null;
}

export interface ProjectedEarlyRepayment {
  ok: true;
  liability: { id: string; name: string; currency: string };
  planId: string;
  /** The debt's live balance at `today`, the draft's staleness anchor. */
  expectedBalanceMinor: number;
  impact: EarlyRepaymentImpact;
}

/**
 * Re-read the live schedule and ask the domain for the impact. Shared by the build
 * and the confirm, so a draft armed against a schedule that has since moved is
 * re-projected rather than replayed.
 */
export async function projectEarlyRepaymentProposal(
  store: LiabilityReads,
  row: ParsedEarlyRepayment,
  today: string,
): Promise<ProjectedEarlyRepayment | { ok: false; error: string }> {
  const liabilities = await store.liabilities.readLiabilities();
  const liability = liabilities.find((item) => item.id === row.liabilityId);
  if (!liability) {
    return { ok: false as const, error: "No encuentro esa deuda en el workspace." };
  }
  const debtModel = await store.liabilities.readDebtModel(row.liabilityId);
  if (debtModel !== "amortizable") {
    return { ok: false as const, error: NO_SCHEDULE_ROUTE };
  }
  const plan = await store.liabilities.readAmortizationPlan(row.liabilityId);
  if (!plan) {
    return {
      ok: false as const,
      error:
        "Esta deuda está marcada como amortizable pero no tiene cuadro de amortización, así que no hay plan al que colgar la anticipada. Revisa su configuración en /patrimonio.",
    };
  }

  // The unique index (plan, date) already forbids two repayments on one date. We
  // detect it HERE so the answer is a sentence instead of a database error — and
  // so re-uploading the same capture next week never doubles the amount.
  const existing = await store.liabilities.readEarlyRepayments(plan.id);
  if (existing.some((item) => item.repaymentDate === row.repaymentDate)) {
    return {
      ok: false as const,
      error: `Esa anticipada ya está registrada: ${liability.name} tiene una del ${formatDayEs(row.repaymentDate)}. No sumo importes ni la duplico; si la cifra registrada es otra, se corrige en /patrimonio/${liability.id}/editar.`,
    };
  }

  const [revisions, balanceRebaselines, cadence] = await Promise.all([
    store.liabilities.readInterestRateRevisions(plan.id),
    store.liabilities.readBalanceRebaselines(row.liabilityId),
    store.liabilities.readValuationCadence(row.liabilityId),
  ]);

  const impact = projectEarlyRepaymentImpact({
    balanceRebaselines,
    cadence,
    currency: liability.currency,
    currentBalanceMinor: liability.currentBalance.amountMinor,
    existing,
    plan: {
      annualInterestRate: plan.annualInterestRate,
      disbursementDate: plan.disbursementDate,
      firstPaymentDate: plan.firstPaymentDate,
      initialCapitalMinor: plan.initialCapitalMinor,
      termMonths: plan.termMonths,
    },
    proposed: {
      amountMinor: row.amountMinor,
      mode: row.mode,
      repaymentDate: row.repaymentDate,
    },
    revisions,
    today,
    ...(row.observedMonthlyPaymentMinor === undefined
      ? {}
      : { observedMonthlyPaymentMinor: row.observedMonthlyPaymentMinor }),
  });
  if (!impact.ok) return impact;

  return {
    expectedBalanceMinor: await store.liabilities.debtBalanceAtDate(
      row.liabilityId,
      today,
    ),
    impact,
    liability: {
      currency: liability.currency,
      id: liability.id,
      name: liability.name,
    },
    ok: true as const,
    planId: plan.id,
  };
}

export async function buildEarlyRepaymentProposal(
  store: ProposalStore,
  raw: unknown,
  today: string,
): Promise<
  { ok: true; proposal: EarlyRepaymentProposal } | { ok: false; error: string }
> {
  const parsed = parseEarlyRepaymentInput(raw, today);
  if (!parsed.ok) return parsed;
  const publicHoldingId =
    isRecord(raw) && typeof raw.publicHoldingId === "string" ? raw.publicHoldingId : "";
  const projected = await projectEarlyRepaymentProposal(store, parsed.row, today);
  if (!projected.ok) return projected;

  const { impact, liability } = projected;
  const plan: EarlyRepaymentPlan = {
    amountMinor: parsed.row.amountMinor,
    holding: publicHoldingId,
    liabilityId: liability.id,
    mode: parsed.row.mode,
    planId: projected.planId,
    repaymentDate: parsed.row.repaymentDate,
    revalidation: {
      asOf: today,
      expectedBalanceMinor: projected.expectedBalanceMinor,
    },
  };

  const proposal = await store.assistantProposals.create({ kind: "early_repayment" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "debt_early_repayment", row: plan }],
  });

  const euros = (amountMinor: number) => money(amountMinor, liability.currency);
  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      folio: EARLY_REPAYMENT_FOLIO,
      holding: { id: publicHoldingId, name: liability.name },
      notes: impact.notes,
      proposalType: "early_repayment",
      reconciliation:
        impact.reconciliation === null
          ? null
          : {
              matches: impact.reconciliation.matches,
              observed: euros(impact.reconciliation.observedMonthlyPaymentMinor),
              plan: euros(impact.reconciliation.planMonthlyPaymentMinor),
            },
      repayment: {
        amount: euros(parsed.row.amountMinor),
        boundaryDate: impact.boundaryDate,
        date: parsed.row.repaymentDate,
        mode: parsed.row.mode,
        modeLabel: earlyRepaymentModeLabel(parsed.row.mode),
      },
      rows: [
        {
          after: euros(impact.balanceAfterMinor),
          before: euros(impact.balanceBeforeMinor),
          label: "Saldo pendiente",
        },
        {
          after: impact.fullyRepaid ? "—" : euros(impact.monthlyPaymentAfterMinor),
          before: euros(impact.monthlyPaymentBeforeMinor),
          label: "Cuota mensual",
        },
        {
          after: formatDayEs(impact.endDateAfter),
          before: formatDayEs(impact.endDateBefore),
          label: "Última cuota",
        },
      ],
      summary: boundProposalSummary(
        parsed.row.summary,
        `Amortización anticipada de ${euros(parsed.row.amountMinor)} en «${liability.name}»`,
      ),
    },
  };
}
