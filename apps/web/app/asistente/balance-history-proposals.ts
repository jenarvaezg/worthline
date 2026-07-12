import { createHash } from "node:crypto";
import {
  type BalanceHistoryRowInput,
  parseBalanceHistoryRows,
  planBalanceHistoryImport,
} from "@web/patrimonio/import-balance-history";
import { readBalanceHistoryDebtContext } from "@web/patrimonio/persist-balance-history-import";
import type {
  AssistantProposal,
  AssistantProposalStore,
  WorthlineStore,
} from "@worthline/db";
import { debtBalanceAtDate } from "@worthline/domain";

import type { BalanceHistoryProposal } from "./balance-history-proposal-contract";

type ProposalStore = Pick<WorthlineStore, "liabilities"> & {
  assistantProposals: AssistantProposalStore;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function observationsFromProposal(proposal: AssistantProposal) {
  if (proposal.kind !== "balance_history_import") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "debt_balance_observation");
  if (facts.length === 0) return null;
  const liabilityIds = new Set(facts.map((fact) => fact.row.liabilityId));
  if (liabilityIds.size !== 1) return null;
  return {
    liabilityId: facts[0]!.row.liabilityId,
    rows: facts.map(({ row }) => ({
      balanceMinor: row.balanceMinor,
      date: row.date,
      ...(row.annualRate === undefined ? {} : { annualRate: row.annualRate }),
    })) as BalanceHistoryRowInput[],
  };
}

export async function projectBalanceHistoryProposal(
  store: Pick<WorthlineStore, "liabilities">,
  liabilityId: string,
  rows: BalanceHistoryRowInput[],
  today: string,
) {
  const liabilities = await store.liabilities.readLiabilities();
  const matches = liabilities.filter((item) => item.id === liabilityId);
  const planRecord = await store.liabilities.readAmortizationPlan(liabilityId);
  const rebaselines = await store.liabilities.readBalanceRebaselines(liabilityId);
  if (matches.length !== 1 || (!planRecord && rebaselines.length === 0)) {
    return { ok: false as const, error: "La deuda no existe o no es amortizable." };
  }
  const liability = matches[0]!;
  const ctx = await readBalanceHistoryDebtContext(
    store as WorthlineStore,
    liabilityId,
    today,
  );
  const plan = planBalanceHistoryImport(rows, ctx);
  if (plan.composed.length === 0) {
    return { ok: false as const, error: "La propuesta no contiene saldos aplicables." };
  }
  const resultingRebaselines = [
    ...ctx.balanceRebaselines,
    ...plan.composed.map((row) => ({ ...row, startsAtBaseline: false })),
  ];
  const balanceAt = (targetDate: string) =>
    debtBalanceAtDate({
      balanceRebaselines: resultingRebaselines,
      currentBalanceMinor: ctx.currentBalanceMinor,
      debtModel: "amortizable",
      ...(ctx.plan ? { plan: ctx.plan } : {}),
      revisions: ctx.revisions,
      targetDate,
    });
  const resultingMinor = balanceAt(today);
  const curve = Array.from(
    new Set([
      ...plan.previews.filter((row) => row.status !== "excluded").map((row) => row.date),
      today,
    ]),
  )
    .sort()
    .map((date) => ({ balanceMinor: balanceAt(date), date }));
  return {
    ok: true as const,
    liability,
    plan,
    curve,
    reconciliation: {
      expectedMinor: ctx.currentBalanceMinor,
      matches: resultingMinor === ctx.currentBalanceMinor,
      resultingMinor,
    },
  };
}

export async function buildBalanceHistoryProposal(
  store: ProposalStore,
  raw: unknown,
  today: string,
) {
  if (!isRecord(raw) || typeof raw.liabilityId !== "string") {
    return { ok: false as const, error: "Falta una deuda inequívoca." };
  }
  const parsedRows = parseBalanceHistoryRows(raw.rows);
  if (!parsedRows.ok) return parsedRows;
  const projected = await projectBalanceHistoryProposal(
    store,
    raw.liabilityId,
    parsedRows.rows,
    today,
  );
  if (!projected.ok) return projected;
  const documentName =
    typeof raw.documentName === "string" && raw.documentName.trim()
      ? raw.documentName.trim().slice(0, 255)
      : "cuadro-amortizacion";
  const proposal = await store.assistantProposals.create({
    kind: "balance_history_import",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: documentName,
      provenance: "agent",
      sha256: createHash("sha256").update(JSON.stringify(parsedRows.rows)).digest("hex"),
    },
    facts: parsedRows.rows.map((row) => ({
      kind: "debt_balance_observation" as const,
      row: { liabilityId: raw.liabilityId as string, ...row },
    })),
  });
  return {
    ok: true as const,
    proposal: {
      proposalType: "balance_history_import" as const,
      draft: { proposalId: proposal.id },
      liability: { id: projected.liability.id, name: projected.liability.name },
      points: projected.plan.previews.map((row) => ({
        date: row.date,
        balanceMinor: row.balanceMinor,
        driftMinor: row.driftMinor,
        status: row.status,
        ...(row.reason === undefined ? {} : { reason: row.reason }),
      })),
      curve: projected.curve,
      reconciliation: projected.reconciliation,
    },
  };
}
