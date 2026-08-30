/**
 * Trust boundary for a statement-import proposal (#933): the fund rows a broker
 * statement previews, each with the ledger the confirm would rewrite.
 */

import type { StatementImportProposal } from "@web/asistente/statement-import-proposals";
import { parseStatementImportProposalDraft } from "@web/asistente/statement-import-proposals";
import { isRecord, parseAll, parseFundPreviewRow } from "./shapes";

export function parseStatementImportProposal(
  raw: unknown,
): StatementImportProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "statement_import") return null;
  const draft = parseStatementImportProposalDraft(raw.draft);
  const funds = parseAll(raw.funds, parseFundPreviewRow);
  if (!draft.ok || funds === null) return null;
  return { draft: draft.draft, funds, proposalType: "statement_import" };
}
