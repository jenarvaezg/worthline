import { STATEMENT_IMPORT_PROPOSAL_SCHEMA } from "@web/asistente/chat-tools/schemas/documents";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { positionsMovementsInContext } from "@web/asistente/reconcile-document-frontier";
import {
  brokerTransactionsInContext,
  statementDocumentRequiredMessage,
} from "@web/asistente/statement-from-transactions-document";
import {
  buildStatementImportProposal,
  buildStatementImportProposalFromDocument,
} from "@web/asistente/statement-import-proposals";
import { unvalidatedEvidenceRejected } from "@web/asistente/unvalidated-evidence-gate";
import {
  PAYWALL_STATEMENT_MESSAGE,
  premiumRequired,
} from "@web/entitlements/paywall-copy";
import { type ToolSet, tool } from "ai";

/**
 * The broker-statement import (PRD #173): a validated transactions document the app
 * reads TAL CUAL, or the plantilla text it parses itself. Either way the figures are
 * never the model's.
 */
export function statementProposalTools(turn: ChatToolTurn): ToolSet {
  const { ingestionGated, input, unvalidatedEvidence } = turn;

  return {
    propose_statement_import: tool({
      description:
        "Prepara una propuesta de importación de extracto de inversión. " +
        "Si en los DATOS ESTRUCTURADOS hay un documento broker_transactions, la app lo usa TAL " +
        "CUAL: llama sin argumentos y no reescribas sus filas. Si no, pasa el texto y nombre " +
        "del documento tal cual (sin calcular números). " +
        "El texto no se persiste: solo los movimientos y la referencia nombre/hash. " +
        "Para acumular otro fichero en la misma propuesta, pasa el proposalId anterior. " +
        "La confirmación re-deriva el matching vivo y sella source: agent.",
      inputSchema: STATEMENT_IMPORT_PROPOSAL_SCHEMA,
      execute: (args) => {
        if (ingestionGated) return premiumRequired(PAYWALL_STATEMENT_MESSAGE);
        // The gate first and unconditionally, exactly as `propose_reconcile` applies it
        // over its own document lane. A validated ledger in CONTEXT is not the same fact
        // as one brought THIS turn: `validatedDocuments` includes history, which comes
        // from the browser and is checked for shape and not authenticity, and lifting the
        // #1248 boundary is the one place that distinction bites (`isValidatedDocument`).
        // The turn that reads a ledger stands the gate down by itself, so this costs the
        // real flow nothing.
        if (unvalidatedEvidence) return unvalidatedEvidenceRejected();
        // The document lane (#1487): with a ledger worthline read, the rows are the
        // reading's and the model contributes nothing but the ask.
        const documents = input.validatedDocuments ?? [];
        const transactions = brokerTransactionsInContext(documents);
        // No ledger and no plantilla text: refuse before opening the store, and name
        // the lane that matches whatever document IS on the table (#1513).
        if (transactions === null && !(args.rawText ?? "").trim()) {
          return Promise.resolve({
            error: "statement_document_required",
            message: statementDocumentRequiredMessage({
              hasPositionsMovements: positionsMovementsInContext(documents) !== null,
            }),
          });
        }
        return input.runWithStore(async (store) => {
          if (!store.assistantProposals) {
            return { error: "proposal_persistence_unavailable" };
          }
          const proposalStore = {
            agentView: store.agentView,
            assistantProposals: store.assistantProposals,
          };
          // What both lanes take from the CALL, resolved once: which document this is and
          // which draft to accumulate onto.
          const named = {
            ...(args.documentName === undefined
              ? {}
              : { documentName: args.documentName }),
            ...(args.proposalId === undefined ? {} : { proposalId: args.proposalId }),
          };
          // The document WINS over `rawText`, and the text is dropped rather than merged
          // — the #1418 rule about provenance: with the document in its context, text the
          // model typed could be figures it remembers from the document instead of from
          // the plantilla, and one remembered row riding in beside eleven read ones is
          // exactly the write nobody validated.
          const built =
            transactions === null
              ? await buildStatementImportProposal(proposalStore, {
                  broker: args.broker ?? "plantilla",
                  rawText: args.rawText ?? "",
                  ...named,
                })
              : await buildStatementImportProposalFromDocument(proposalStore, {
                  document: transactions,
                  ...named,
                });
          return built.ok ? built.proposal : { error: built.error };
        });
      },
    }),
  };
}
