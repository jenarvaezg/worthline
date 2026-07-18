"use server";

import { createStableId, resolveOwnershipSplit } from "@web/intake";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  readPortfolioInvestments,
  statementImportPreviewReadPort,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import {
  buildStatementImportPlan,
  findStatementTypeConflict,
  isIsinShaped,
  resolveStatementImportBuckets,
} from "@worthline/domain";

import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import {
  parsePropertyValuationAnchorInput,
  projectPropertyValuationProposal,
} from "./property-valuation-proposals";
import { runProposalConfirm } from "./proposal-action";
import {
  selectionsFromPreviewFunds,
  statementFromAssistantProposal,
} from "./statement-import-proposals";

export async function confirmMixedDocumentProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
) {
  return runProposalConfirm<{ sections: number }>({
    rawDraft,
    testArgs: _testArgs,
    kind: "mixed_document_import",
    parse: (raw) => {
      if (
        raw === null ||
        typeof raw !== "object" ||
        typeof (raw as { proposalId?: unknown }).proposalId !== "string"
      ) {
        return { ok: false, message: "Falta la referencia de la propuesta." };
      }
      return {
        ok: true,
        proposalId: (raw as { proposalId: string }).proposalId,
        data: undefined,
      };
    },
    apply: async ({ store, proposal, today }) => {
      const seed = Date.now();
      const statement = statementFromAssistantProposal(proposal);
      const funds = [] as Parameters<
        typeof store.command.applyAssistantMixedProposal
      >[0]["funds"];
      if (statement && statement.rows.length > 0) {
        const readPort = statementImportPreviewReadPort(store);
        const preview = await buildStatementImportPreview(
          readPort,
          statement,
          defaultIsinSymbolResolver,
        );
        if (!preview.ok) return { status: "error", message: preview.message };
        const buckets = resolveStatementImportBuckets(
          statement,
          await readPortfolioInvestments(readPort),
        );
        if (findStatementTypeConflict(buckets))
          return {
            status: "error",
            message: "La clasificación de una inversión ya no es inequívoca.",
          };
        const workspace = await store.workspace.readWorkspace();
        if (!workspace) return { status: "error", message: "Workspace no inicializado." };
        const ownership = resolveOwnershipSplit({
          activeMembers: workspace.members.filter((member) => !member.disabledAt),
          preset: "scope",
          shortfall: "complete-to-full-ownership",
        });
        const plan = buildStatementImportPlan(
          buckets,
          selectionsFromPreviewFunds(buckets, preview.funds, ownership, seed),
        );
        funds.push(
          ...plan.included.map((fund, index) => {
            const assetId =
              fund.kind === "matched" ? fund.assetId : fund.creation.assetId;
            const creates = (
              fund.kind === "matched" ? fund.mergePlan.toCreate : fund.rows
            ).map((row, ordinal) => ({
              assetId,
              currency: row.currency,
              executedAt: row.dateKey,
              feesMinor: row.feesMinor,
              id: createStableId(
                "op",
                `${assetId}_${row.dateKey}`,
                seed + index * 1000 + ordinal,
              ),
              kind: row.kind,
              pricePerUnit: row.pricePerUnit,
              source: "agent" as const,
              units: row.units,
              ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
            }));
            if (fund.kind === "matched") {
              return {
                assetId,
                creates,
                deletes: fund.mergePlan.toDelete.map((row) => row.id),
                kind: "matched" as const,
                overwrites: fund.mergePlan.toOverwrite.map(({ operationId, row }) => ({
                  currency: row.currency,
                  feesMinor: row.feesMinor,
                  id: operationId,
                  kind: row.kind,
                  pricePerUnit: row.pricePerUnit,
                  source: "agent" as const,
                  units: row.units,
                  ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
                })),
              };
            }
            return {
              asset: {
                currency: fund.creation.currency,
                id: assetId,
                ...(isIsinShaped(fund.isin) ? { isin: fund.isin } : {}),
                name: fund.creation.name,
                ownership: fund.creation.ownership,
                ...(fund.creation.instrument
                  ? { instrument: fund.creation.instrument }
                  : {}),
                ...(fund.creation.liquidityTier
                  ? { liquidityTier: fund.creation.liquidityTier }
                  : {}),
                ...(fund.creation.priceProvider
                  ? { priceProvider: fund.creation.priceProvider }
                  : {}),
                ...(fund.creation.providerSymbol
                  ? { providerSymbol: fund.creation.providerSymbol }
                  : {}),
              },
              creates,
              kind: "new" as const,
            };
          }),
        );
      }

      const balanceHistories = [] as NonNullable<
        Parameters<
          typeof store.command.applyAssistantMixedProposal
        >[0]["balanceHistories"]
      >;
      const debtFacts = proposal.documents
        .flatMap((document) => document.facts)
        .filter((fact) => fact.kind === "debt_balance_observation");
      for (const liabilityId of new Set(debtFacts.map((fact) => fact.row.liabilityId))) {
        const rows = debtFacts
          .filter((fact) => fact.row.liabilityId === liabilityId)
          .map((fact) => fact.row);
        const projected = await projectBalanceHistoryProposal(
          store,
          liabilityId,
          rows,
          today,
        );
        if (!projected.ok || !projected.reconciliation.matches)
          return {
            status: "error",
            message: "Una deuda ya no reconcilia con su saldo actual.",
          };
        balanceHistories.push({
          liabilityId,
          rebaselines: projected.plan.composed.map((row) => ({
            ...row,
            id: createStableId("rebaseline", `${liabilityId}_${row.baselineDate}`, 0),
            liabilityId,
            source: "agent" as const,
            startsAtBaseline: false,
          })),
        });
      }

      const propertyValuations = [] as NonNullable<
        Parameters<
          typeof store.command.applyAssistantMixedProposal
        >[0]["propertyValuations"]
      >;
      const propertyFacts = proposal.documents
        .flatMap((document) => document.facts)
        .filter((fact) => fact.kind === "property_valuation_anchor");
      for (const [index, fact] of propertyFacts.entries()) {
        const parsed = parsePropertyValuationAnchorInput(fact.row, today);
        if (!parsed.ok) return { status: "error", message: parsed.error };
        const projected = await projectPropertyValuationProposal(
          store,
          parsed.row.assetId,
          parsed.row.valuationDate,
          parsed.row.valueMinor,
          today,
        );
        if (!projected.ok) return { status: "error", message: projected.error };
        propertyValuations.push({
          ...parsed.row,
          adjustsPriorCurve: true,
          id: createStableId(
            "valuation_anchor",
            `${parsed.row.assetId}_${parsed.row.valuationDate}`,
            index,
          ),
          source: "agent",
        });
      }

      await store.command.applyAssistantMixedProposal({
        balanceHistories,
        funds,
        propertyValuations,
        proposalId: proposal.id,
        today,
      });
      return {
        status: "applied",
        sections: new Set([
          ...(funds.length ? ["investment"] : []),
          ...(balanceHistories.length ? ["debt"] : []),
          ...(propertyValuations.length ? ["property"] : []),
        ]).size,
      };
    },
  });
}
