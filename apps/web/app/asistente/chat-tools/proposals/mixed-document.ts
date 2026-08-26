import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import {
  MIXED_DOCUMENT_PROPOSAL_SCHEMA,
  type MixedDocumentSegmentArg,
} from "@web/asistente/chat-tools/schemas/documents";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { buildMixedDocumentProposal } from "@web/asistente/mixed-document-proposals";
import { unvalidatedEvidenceRejected } from "@web/asistente/unvalidated-evidence-gate";
import {
  PAYWALL_RECONCILE_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * The mixed-document import (ADR 0059): the model draws the segment boundaries and
 * classifies each one; the app routes every segment to its own typed extractor and
 * confirms all-or-nothing.
 */
export function mixedDocumentProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input, unvalidatedEvidence } = turn;

  return {
    propose_mixed_document_import: tool({
      description:
        "Segmenta un documento mixto y prepara UNA propuesta multi-dominio. Agrupa por tipo y activo, y usa confidence=certain solo cuando tipo, columnas y activo son inequívocos. Si cualquier segmento es dudoso, NO llames esta tool: pregunta al usuario. La app enruta cada segmento a su extractor tipado, calcula previews y confirma todo-o-nada con un único ripple.",
      inputSchema: MIXED_DOCUMENT_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_RECONCILE_MESSAGE);
        if (unvalidatedEvidence) return unvalidatedEvidenceRejected();
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals || !store.liabilities || !store.assets)
            return { error: "proposal_persistence_unavailable" };
          // The holding reference is resolved to an internal id on the two branches
          // that carry one; a statement segment has none and travels untouched.
          const segments: MixedDocumentSegmentArg[] = [];
          for (const segment of args.segments ?? []) {
            if (
              segment.kind === "debt_balance_history" &&
              typeof segment.liabilityId === "string"
            ) {
              segments.push({
                ...segment,
                liabilityId: await resolveInternalHoldingId(
                  store.agentView,
                  segment.liabilityId,
                ),
              });
            } else if (
              segment.kind === "property_valuation" &&
              typeof segment.assetId === "string"
            ) {
              segments.push({
                ...segment,
                assetId: await resolveInternalHoldingId(store.agentView, segment.assetId),
              });
            } else {
              segments.push(segment);
            }
          }
          const built = await buildMixedDocumentProposal(
            {
              agentView: store.agentView,
              assets: store.assets,
              assistantProposals: store.assistantProposals,
              liabilities: store.liabilities,
            },
            { ...args, segments },
            input.asOf,
          );
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
  };
}
