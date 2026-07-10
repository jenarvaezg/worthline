import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  type FundPreviewRow,
  parseStatementBroker,
  readStatementFromText,
  type StatementImportPreviewReadPort,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import type { StatementBroker, StatementFundSelection } from "@worthline/domain";

export interface StatementImportNewFundDraft {
  isin: string;
  name: string;
  symbol?: string;
}

export type StatementImportSelectionDraft =
  | { action: "ignore"; isin: string }
  | { action: "include"; isin: string; newFund?: StatementImportNewFundDraft };

export interface StatementImportProposalDraft {
  broker: StatementBroker;
  rawText: string;
  selections?: StatementImportSelectionDraft[];
}

export interface StatementImportProposal {
  proposalType: "statement_import";
  draft: StatementImportProposalDraft;
  funds: FundPreviewRow[];
}

export type StatementImportProposalParseResult =
  | { ok: true; draft: StatementImportProposalDraft }
  | { ok: false; error: string };

export type StatementImportProposalBuildResult =
  | { ok: true; proposal: StatementImportProposal }
  | { ok: false; error: string };

const MAX_RAW_TEXT_CHARS = 500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSelection(raw: unknown): StatementImportSelectionDraft | null {
  if (!isRecord(raw) || typeof raw["isin"] !== "string" || raw["isin"].trim() === "") {
    return null;
  }
  const isin = raw["isin"].trim();
  if (raw["action"] === "ignore") return { action: "ignore", isin };
  if (raw["action"] !== "include") return null;

  const newFundRaw = raw["newFund"];
  if (newFundRaw === undefined) return { action: "include", isin };
  if (!isRecord(newFundRaw) || typeof newFundRaw["name"] !== "string") return null;

  const name = newFundRaw["name"].trim();
  if (name === "") return null;
  const symbol =
    typeof newFundRaw["symbol"] === "string" ? newFundRaw["symbol"].trim() : undefined;

  return {
    action: "include",
    isin,
    newFund: {
      isin,
      name,
      ...(symbol ? { symbol } : {}),
    },
  };
}

export function parseStatementImportProposalDraft(
  raw: unknown,
): StatementImportProposalParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "El borrador de importación no es válido." };
  }

  const broker = parseStatementBroker(raw["broker"] ?? "plantilla");
  if (broker === null) {
    return { ok: false, error: "El formato de extracto no es compatible." };
  }

  if (typeof raw["rawText"] !== "string") {
    return { ok: false, error: "Falta el texto del extracto." };
  }
  const rawText = raw["rawText"].trim();
  if (rawText.length === 0 || rawText.length > MAX_RAW_TEXT_CHARS) {
    return { ok: false, error: "El texto del extracto no es válido." };
  }

  const read = readStatementFromText(rawText, broker);
  if (!read.ok) {
    return { ok: false, error: read.message };
  }

  const selections: StatementImportSelectionDraft[] = [];
  if (raw["selections"] !== undefined) {
    if (!Array.isArray(raw["selections"])) {
      return { ok: false, error: "Las selecciones del extracto no son válidas." };
    }
    for (const item of raw["selections"]) {
      const selection = parseSelection(item);
      if (selection === null) {
        return { ok: false, error: "Las selecciones del extracto no son válidas." };
      }
      selections.push(selection);
    }
  }

  return {
    ok: true,
    draft: {
      broker,
      rawText,
      ...(selections.length > 0 ? { selections } : {}),
    },
  };
}

export async function buildStatementImportProposal(
  store: StatementImportPreviewReadPort,
  rawDraft: unknown,
): Promise<StatementImportProposalBuildResult> {
  const parsed = parseStatementImportProposalDraft(rawDraft);
  if (!parsed.ok) return parsed;

  const read = readStatementFromText(parsed.draft.rawText, parsed.draft.broker);
  if (!read.ok) return { ok: false, error: read.message };

  const preview = await buildStatementImportPreview(
    store,
    read.value,
    defaultIsinSymbolResolver,
  );
  if (!preview.ok) return { ok: false, error: preview.message };

  return {
    ok: true,
    proposal: {
      proposalType: "statement_import",
      draft: parsed.draft,
      funds: preview.funds,
    },
  };
}

export function defaultStatementImportSelections(
  funds: FundPreviewRow[],
): StatementImportSelectionDraft[] {
  return funds.map((fund) => ({ action: "include", isin: fund.isin }));
}

export function selectionsFromDraft(
  funds: FundPreviewRow[],
  draft: StatementImportProposalDraft,
): StatementImportSelectionDraft[] {
  if (!draft.selections || draft.selections.length === 0) {
    return defaultStatementImportSelections(funds);
  }

  const knownIsins = new Set(funds.map((fund) => fund.isin));
  const byIsin = new Map(
    draft.selections.map((selection) => [selection.isin, selection]),
  );

  return funds
    .map((fund) => {
      const selection = byIsin.get(fund.isin);
      if (!selection) return { action: "include" as const, isin: fund.isin };
      if (selection.action === "ignore") return selection;
      if (fund.bucket === "new" && selection.newFund === undefined) {
        return {
          action: "include" as const,
          isin: fund.isin,
          newFund: {
            isin: fund.isin,
            name: fund.suggestedName || fund.isin,
            ...(fund.suggestedSymbol ? { symbol: fund.suggestedSymbol } : {}),
          },
        };
      }
      return selection;
    })
    .filter((selection) => knownIsins.has(selection.isin));
}

export type { StatementFundSelection };
