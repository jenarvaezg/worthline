"use server";

import { testArgFromActionArgs } from "@web/action-store";
import { createStableId, resolveOwnershipSplit } from "@web/intake";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  isIsinSymbolResolver,
  readPortfolioInvestments,
  statementImportPreviewReadPort,
  typeConflictMessage,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import {
  buildStatementImportPlan,
  findStatementTypeConflict,
  isIsinShaped,
  type ParsedStatementRow,
  resolveStatementImportBuckets,
} from "@worthline/domain";

import { runProposalConfirm, runProposalDiscard } from "./proposal-action";
import {
  parseStatementImportProposalDraft,
  selectionsFromPreviewFunds,
  statementFromAssistantProposal,
} from "./statement-import-proposals";

function rowToCreateInput(
  assetId: string,
  row: ParsedStatementRow,
  id: string,
  source: "agent",
) {
  return {
    assetId,
    currency: row.currency,
    executedAt: row.dateKey,
    feesMinor: row.feesMinor,
    id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source,
    units: row.units,
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
  };
}

export type StatementImportProposalConfirmResult =
  | { status: "applied"; included: number; created: number }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

export async function confirmStatementImportProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<StatementImportProposalConfirmResult> {
  const _resolver =
    testArgFromActionArgs(_testArgs, isIsinSymbolResolver) ?? defaultIsinSymbolResolver;
  return runProposalConfirm<{ included: number; created: number }>({
    rawDraft,
    testArgs: _testArgs,
    kind: "statement_import",
    parse: (raw) => {
      const p = parseStatementImportProposalDraft(raw);
      return p.ok
        ? { ok: true, proposalId: p.draft.proposalId, data: undefined }
        : { ok: false, message: p.error };
    },
    apply: async ({ store, proposal, today }) => {
      const seed = Date.now();
      const statement = statementFromAssistantProposal(proposal);
      if (!statement || statement.rows.length === 0) {
        return { status: "error", message: "La propuesta no contiene movimientos." };
      }

      const readPort = statementImportPreviewReadPort(store);
      const preview = await buildStatementImportPreview(readPort, statement, _resolver);
      if (!preview.ok) {
        return { status: "error", message: preview.message };
      }

      const investments = await readPortfolioInvestments(readPort);
      const buckets = resolveStatementImportBuckets(statement, investments);
      const conflict = findStatementTypeConflict(buckets);
      if (conflict) {
        return { status: "error", message: typeConflictMessage(conflict) };
      }

      const workspace = await store.workspace.readWorkspace();
      if (!workspace) {
        return { status: "error", message: "Workspace no inicializado." };
      }

      const activeMembers = workspace.members.filter((member) => !member.disabledAt);
      const ownership = resolveOwnershipSplit({
        activeMembers,
        preset: "scope",
        shortfall: "complete-to-full-ownership",
      });

      const selections = selectionsFromPreviewFunds(
        buckets,
        preview.funds,
        ownership,
        seed,
      );
      const plan = buildStatementImportPlan(buckets, selections);

      const funds = plan.included.map((fund, index) => {
        const opSeed = `${seed}_${index}`;

        if (fund.kind === "matched") {
          return {
            assetId: fund.assetId,
            creates: fund.mergePlan.toCreate.map((row, j) =>
              rowToCreateInput(
                fund.assetId,
                row,
                createStableId(
                  "op",
                  `${fund.assetId}_${row.dateKey}`,
                  seed + index * 1000 + j,
                ),
                "agent",
              ),
            ),
            deletes: fund.mergePlan.toDelete.map((operation) => operation.id),
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
            id: fund.creation.assetId,
            ...(isIsinShaped(fund.isin) ? { isin: fund.isin } : {}),
            name: fund.creation.name,
            ownership: fund.creation.ownership,
            ...(fund.creation.instrument ? { instrument: fund.creation.instrument } : {}),
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
          creates: fund.rows.map((row, j) =>
            rowToCreateInput(
              fund.creation.assetId,
              row,
              `create_${opSeed}_${j}`,
              "agent",
            ),
          ),
          kind: "new" as const,
        };
      });

      await store.command.applyAssistantStatementProposal({
        funds,
        proposalId: proposal.id,
        today,
      });

      return {
        created: plan.included.filter((fund) => fund.kind === "new").length,
        included: plan.included.length,
        status: "applied",
      };
    },
  });
}

export type StatementImportProposalDiscardResult =
  | { status: "discarded" }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

export async function discardStatementImportProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<StatementImportProposalDiscardResult> {
  return runProposalDiscard({
    rawDraft,
    testArgs: _testArgs,
    kind: "statement_import",
    parse: (raw) => {
      const p = parseStatementImportProposalDraft(raw);
      return p.ok
        ? { ok: true, proposalId: p.draft.proposalId, data: undefined }
        : { ok: false, message: p.error };
    },
  });
}
