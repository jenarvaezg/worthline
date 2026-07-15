/**
 * Correction proposal builder (#1051). Turns a chat-declared correction into a
 * persisted `correction` assistant proposal (superficie C «Ancla primero», mode
 * "Solo desde hoy"): it reads the target holding's live state, diagnoses the
 * primitive to write by family (cause-first, re-baseline fallback — ADR 0056),
 * records the before-values, and stamps a live-data revalidation so a stale
 * confirm fails honestly. It writes NOTHING — the app applies it on confirm.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantProposalStore,
  CorrectionEdit,
  CorrectionPlan,
  WorthlineStore,
} from "@worthline/db";
import { formatMoneyMinor, type ValuationCadence } from "@worthline/domain";
import type {
  CorrectionProposal,
  CorrectionProposalEditRow,
} from "./correction-proposal-contract";

type ProposalStore = Pick<WorthlineStore, "liabilities" | "assets"> & {
  assistantProposals: AssistantProposalStore;
};

/** The correction the model declares, discriminated by `kind`. */
export interface CorrectionArgs {
  holdingId: string; // resolved to an internal id before building
  publicHoldingId: string; // the wl_hld_… echoed back to the card
  summary?: string;
  correction: CorrectionInput;
}

export type CorrectionInput =
  | {
      kind: "declare_balance";
      balanceMinor: number;
      date?: string;
      endDate?: string;
      monthlyPaymentMinor?: number;
      annualRate?: string;
    }
  | { kind: "declare_value"; valueMinor: number; date?: string }
  | { kind: "change_debt_model"; debtModel: "amortizable" | "revolving" | "informal" }
  | {
      kind: "edit_config";
      name?: string;
      ownership?: Array<{ memberId: string; shareBps: number }>;
      cadence?: ValuationCadence | null;
      plan?: {
        annualInterestRate?: string;
        termMonths?: number;
        firstPaymentDate?: string;
      };
    };

type BuildResult =
  | { ok: true; proposal: CorrectionProposal }
  | { ok: false; error: string };

function euros(currency: string, minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  return formatMoneyMinor({ amountMinor: minor, currency });
}

/**
 * A fresh unique dated-fact id per edit. Random (not date-derived) so a second
 * same-day correction of the same holding never collides with the first.
 */
function factId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const FOLIO = "1 propuesta · 1 holding · 1 lote atómico";

export async function buildCorrectionProposal(
  store: ProposalStore,
  args: CorrectionArgs,
  today: string,
): Promise<BuildResult> {
  const liabilities = await store.liabilities.readLiabilities();
  const liability = liabilities.find((item) => item.id === args.holdingId);
  if (liability) {
    return buildDebtCorrection(store, args, liability, today);
  }
  const assets = await store.assets.readAssets();
  const asset = assets.find((item) => item.id === args.holdingId);
  if (asset) {
    return buildAssetCorrection(store, args, asset, today);
  }
  return { ok: false, error: "No encuentro ese holding en el workspace." };
}

async function buildDebtCorrection(
  store: ProposalStore,
  args: CorrectionArgs,
  liability: Awaited<
    ReturnType<WorthlineStore["liabilities"]["readLiabilities"]>
  >[number],
  today: string,
): Promise<BuildResult> {
  const { correction } = args;
  const currency = liability.currency;
  const debtModel = await store.liabilities.readDebtModel(liability.id);
  const liveBalance = await store.liabilities.debtBalanceAtDate(liability.id, today);
  const edits: CorrectionEdit[] = [];
  const rows: CorrectionProposalEditRow[] = [];

  if (correction.kind === "declare_balance") {
    if (!Number.isFinite(correction.balanceMinor)) {
      return { ok: false, error: "Falta el saldo real (en céntimos) a declarar." };
    }
    const date = correction.date ?? today;
    if (debtModel === "amortizable") {
      // Cause-first would register the missing early repayment/revision; when the
      // real event is unknown the honest repair is a re-baseline (ADR 0056):
      // declare the real balance today and re-derive the schedule forward.
      const hasRate = typeof correction.annualRate === "string";
      const hasPayment = typeof correction.monthlyPaymentMinor === "number";
      if (hasRate === hasPayment) {
        return {
          ok: false,
          error:
            "Una recalibración necesita exactamente el tipo anual O la cuota mensual, no ambos ni ninguno.",
        };
      }
      if (!correction.endDate) {
        return { ok: false, error: "Falta la fecha de fin para recalibrar el préstamo." };
      }
      edits.push({
        before: { balanceMinor: liveBalance },
        input: {
          baselineDate: date,
          endDate: correction.endDate,
          id: factId("reb"),
          liabilityId: liability.id,
          nextPaymentDate: date,
          outstandingBalanceMinor: correction.balanceMinor,
          source: "agent",
          ...(hasRate ? { annualInterestRate: correction.annualRate } : {}),
          ...(hasPayment ? { monthlyPaymentMinor: correction.monthlyPaymentMinor } : {}),
        },
        kind: "debt_rebaseline",
      });
    } else {
      // Revolving/informal: a balance anchor at the declared date.
      edits.push({
        before: { balanceMinor: liveBalance },
        input: {
          anchorDate: date,
          balanceMinor: correction.balanceMinor,
          id: factId("anchor"),
          liabilityId: liability.id,
        },
        kind: "balance_anchor",
      });
    }
    rows.push({
      after: euros(currency, correction.balanceMinor),
      before: euros(currency, liveBalance),
      label: "Saldo pendiente",
      origin: "assistant",
    });
  } else if (correction.kind === "change_debt_model") {
    if (correction.debtModel === debtModel) {
      return { ok: false, error: "El préstamo ya usa ese modelo." };
    }
    edits.push({
      before: debtModel,
      debtModel: correction.debtModel,
      kind: "debt_model",
      liabilityId: liability.id,
    });
    rows.push({
      after: correction.debtModel,
      before: debtModel ?? "—",
      label: "Modelo de deuda",
      origin: "assistant",
    });
  } else if (correction.kind === "edit_config") {
    appendConfigEdits(edits, rows, {
      cadence: correction.cadence,
      currentName: liability.name,
      currentOwnership: liability.ownership,
      name: correction.name,
      ownership: correction.ownership,
      side: "liability",
      targetId: liability.id,
    });
    if (correction.plan) {
      const plan = await store.liabilities.readAmortizationPlan(liability.id);
      if (!plan) {
        return {
          ok: false,
          error: "Este préstamo no tiene plan de amortización que editar.",
        };
      }
      edits.push({
        before: {
          annualInterestRate: plan.annualInterestRate,
          termMonths: plan.termMonths,
        },
        input: {
          ...(correction.plan.annualInterestRate === undefined
            ? {}
            : { annualInterestRate: correction.plan.annualInterestRate }),
          ...(correction.plan.termMonths === undefined
            ? {}
            : { termMonths: correction.plan.termMonths }),
          ...(correction.plan.firstPaymentDate === undefined
            ? {}
            : { firstPaymentDate: correction.plan.firstPaymentDate }),
        },
        kind: "amortization_plan",
        liabilityId: liability.id,
        planId: plan.id,
      });
      if (correction.plan.annualInterestRate !== undefined) {
        rows.push({
          after: `${correction.plan.annualInterestRate}`,
          before: `${plan.annualInterestRate}`,
          label: "Tipo anual",
          origin: "assistant",
        });
      }
    }
    if (edits.length === 0) {
      return { ok: false, error: "La corrección de configuración no cambia nada." };
    }
  } else {
    return {
      ok: false,
      error:
        "Esa corrección no aplica a una deuda; declara un saldo o edita su configuración.",
    };
  }

  return persist(store, args, liability.name, edits, rows, {
    asOf: today,
    expectedBalanceMinor: liveBalance,
    liabilityId: liability.id,
  });
}

async function buildAssetCorrection(
  store: ProposalStore,
  args: CorrectionArgs,
  asset: Awaited<ReturnType<WorthlineStore["assets"]["readAssets"]>>[number],
  today: string,
): Promise<BuildResult> {
  const { correction } = args;
  const currency = asset.currency;
  const edits: CorrectionEdit[] = [];
  const rows: CorrectionProposalEditRow[] = [];

  if (correction.kind === "declare_value") {
    if (!Number.isFinite(correction.valueMinor)) {
      return { ok: false, error: "Falta el valor real (en céntimos) a declarar." };
    }
    edits.push({
      before: { valueMinor: asset.currentValue.amountMinor },
      input: {
        adjustsPriorCurve: true,
        assetId: asset.id,
        id: factId("val"),
        source: "agent",
        valuationDate: correction.date ?? today,
        valueMinor: correction.valueMinor,
      },
      kind: "valuation_anchor",
    });
    rows.push({
      after: euros(currency, correction.valueMinor),
      before: euros(currency, asset.currentValue.amountMinor),
      label: "Valor de mercado",
      origin: "assistant",
    });
  } else if (correction.kind === "edit_config") {
    appendConfigEdits(edits, rows, {
      cadence: correction.cadence,
      currentName: asset.name,
      currentOwnership: asset.ownership,
      name: correction.name,
      ownership: correction.ownership,
      side: "asset",
      targetId: asset.id,
    });
    if (edits.length === 0) {
      return { ok: false, error: "La corrección de configuración no cambia nada." };
    }
  } else {
    return {
      ok: false,
      error:
        "Esa corrección no aplica a este activo; declara su valor o edita su configuración.",
    };
  }

  return persist(store, args, asset.name, edits, rows);
}

/** Shared config edits (name / ownership / cadence) for either side. */
function appendConfigEdits(
  edits: CorrectionEdit[],
  rows: CorrectionProposalEditRow[],
  params: {
    side: "asset" | "liability";
    targetId: string;
    currentName: string;
    currentOwnership: Array<{ memberId: string; shareBps: number }>;
    name: string | undefined;
    ownership: Array<{ memberId: string; shareBps: number }> | undefined;
    cadence: ValuationCadence | null | undefined;
  },
): void {
  const patch: {
    name?: string;
    ownership?: Array<{ memberId: string; shareBps: number }>;
  } = {};
  const before: { name?: string; ownership?: typeof params.currentOwnership } = {};
  if (params.name !== undefined && params.name !== params.currentName) {
    patch.name = params.name;
    before.name = params.currentName;
    rows.push({
      after: params.name,
      before: params.currentName,
      label: "Nombre",
      origin: "assistant",
    });
  }
  if (params.ownership !== undefined) {
    patch.ownership = params.ownership;
    before.ownership = params.currentOwnership;
    rows.push({
      after: params.ownership.map((o) => `${o.shareBps / 100}%`).join(" · "),
      before: params.currentOwnership.map((o) => `${o.shareBps / 100}%`).join(" · "),
      label: "Titularidad",
      origin: "assistant",
    });
  }
  if (Object.keys(patch).length > 0) {
    edits.push(
      params.side === "liability"
        ? { before, kind: "liability_config", liabilityId: params.targetId, patch }
        : { before, kind: "asset_config", assetId: params.targetId, patch },
    );
  }
  if (params.cadence !== undefined) {
    edits.push(
      params.side === "liability"
        ? {
            before: null,
            cadence: params.cadence,
            kind: "liability_cadence",
            liabilityId: params.targetId,
          }
        : {
            before: null,
            cadence: params.cadence,
            kind: "housing_cadence",
            assetId: params.targetId,
          },
    );
    rows.push({
      after:
        params.cadence === "step"
          ? "escalón"
          : params.cadence === "interpolated"
            ? "interpolada"
            : "—",
      before: "cadencia anterior",
      label: "Cadencia de valoración",
      origin: "assistant",
    });
  }
}

async function persist(
  store: ProposalStore,
  args: CorrectionArgs,
  holdingName: string,
  edits: CorrectionEdit[],
  rows: CorrectionProposalEditRow[],
  revalidation?: { liabilityId: string; asOf: string; expectedBalanceMinor: number },
): Promise<BuildResult> {
  if (edits.length === 0) return { ok: false, error: "La corrección no cambia nada." };
  const plan: CorrectionPlan = {
    edits,
    holding: args.publicHoldingId,
    mode: "anchor-only",
    ...(revalidation ? { revalidation } : {}),
  };
  const proposal = await store.assistantProposals.create({ kind: "correction" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "holding_correction", row: plan }],
  });
  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      edits: rows,
      folio: FOLIO,
      guarantee: { state: "declared" },
      holding: { id: args.publicHoldingId, name: holdingName },
      mode: "solo-desde-hoy",
      proposalType: "correction",
      summary: args.summary?.trim() || `Corrección de «${holdingName}»`,
    },
  };
}
