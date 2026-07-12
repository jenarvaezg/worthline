import { createHash } from "node:crypto";
import { createStableId } from "@web/intake";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  type FundPreviewRow,
  type IsinSymbolResolver,
  parseStatementBroker,
  readStatementFromText,
  type StatementImportPreviewReadPort,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import type { AssistantProposal, AssistantProposalStore } from "@worthline/db";
import type {
  OwnershipShare,
  ParsedStatement,
  StatementBroker,
  StatementFundSelection,
  StatementImportBucket,
} from "@worthline/domain";
import { defaultsFor, type InvestmentPriceProvider } from "@worthline/domain";

export interface StatementImportProposalDraft {
  proposalId: string;
}

export interface StatementImportProposalExtraction {
  broker: StatementBroker;
  documentName?: string;
  proposalId?: string;
  rawText: string;
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

export interface StatementImportProposalStore {
  agentView: StatementImportPreviewReadPort;
  assistantProposals: AssistantProposalStore;
}

const MAX_RAW_TEXT_CHARS = 500_000;
const MAX_DOCUMENT_NAME_CHARS = 255;
const MAX_PROPOSAL_ID_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseStatementImportProposalDraft(
  raw: unknown,
): StatementImportProposalParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "El borrador de importación no es válido." };
  }

  if (typeof raw["proposalId"] !== "string") {
    return { ok: false, error: "Falta la referencia de la propuesta." };
  }
  const proposalId = raw["proposalId"].trim();
  if (proposalId.length === 0 || proposalId.length > MAX_PROPOSAL_ID_CHARS) {
    return { ok: false, error: "La referencia de la propuesta no es válida." };
  }

  return {
    ok: true,
    draft: { proposalId },
  };
}

function parsedStatementFromDocuments(
  documents: AssistantProposal["documents"],
): ParsedStatement {
  const rows = documents.flatMap((document) => document.facts.map((fact) => fact.row));
  const isins = Array.from(
    new Set(
      rows
        .map((row) => row.isin)
        .filter((isin): isin is string => isin !== null && isin !== ""),
    ),
  );
  return {
    directionResolved: true,
    isin: isins.length === 1 ? isins[0]! : null,
    isins,
    rows,
    skipped: [],
  };
}

export function statementFromAssistantProposal(
  proposal: AssistantProposal,
): ParsedStatement | null {
  if (proposal.kind !== "statement_import") return null;
  return parsedStatementFromDocuments(proposal.documents);
}

function parseExtraction(
  raw: unknown,
): { ok: true; value: StatementImportProposalExtraction } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: "La extracción del documento no es válida." };
  }
  const broker = parseStatementBroker(raw["broker"] ?? "plantilla");
  if (broker === null) {
    return { ok: false, error: "El formato de extracto no es compatible." };
  }
  if (typeof raw["rawText"] !== "string") {
    return { ok: false, error: "Falta el texto del extracto." };
  }
  const rawText = raw["rawText"];
  if (rawText.trim().length === 0 || rawText.length > MAX_RAW_TEXT_CHARS) {
    return { ok: false, error: "El texto del extracto no es válido." };
  }
  const documentNameRaw = raw["documentName"] ?? `${broker}.csv`;
  if (typeof documentNameRaw !== "string") {
    return { ok: false, error: "El nombre del documento no es válido." };
  }
  const documentName = documentNameRaw.trim();
  if (documentName.length === 0 || documentName.length > MAX_DOCUMENT_NAME_CHARS) {
    return { ok: false, error: "El nombre del documento no es válido." };
  }
  const proposalIdRaw = raw["proposalId"];
  if (
    proposalIdRaw !== undefined &&
    (typeof proposalIdRaw !== "string" ||
      proposalIdRaw.trim().length === 0 ||
      proposalIdRaw.trim().length > MAX_PROPOSAL_ID_CHARS)
  ) {
    return { ok: false, error: "La referencia de la propuesta no es válida." };
  }
  return {
    ok: true,
    value: {
      broker,
      documentName,
      ...(typeof proposalIdRaw === "string" ? { proposalId: proposalIdRaw.trim() } : {}),
      rawText,
    },
  };
}

export async function buildStatementImportProposal(
  store: StatementImportProposalStore,
  rawExtraction: unknown,
  resolver: IsinSymbolResolver = defaultIsinSymbolResolver,
): Promise<StatementImportProposalBuildResult> {
  const parsed = parseExtraction(rawExtraction);
  if (!parsed.ok) return parsed;

  const read = readStatementFromText(parsed.value.rawText, parsed.value.broker);
  if (!read.ok) return { ok: false, error: read.message };

  const existing = parsed.value.proposalId
    ? await store.assistantProposals.read(parsed.value.proposalId)
    : null;
  if (parsed.value.proposalId && !existing) {
    return { ok: false, error: "La propuesta ya no existe." };
  }
  if (existing && existing.status !== "draft") {
    return { ok: false, error: "La propuesta ya está resuelta." };
  }
  if (existing && existing.kind !== "statement_import") {
    return { ok: false, error: "La propuesta no es de extractos de inversión." };
  }

  const existingStatement = existing
    ? parsedStatementFromDocuments(existing.documents)
    : null;
  const combinedStatement: ParsedStatement = existingStatement
    ? {
        ...existingStatement,
        directionResolved:
          existingStatement.directionResolved && read.value.directionResolved,
        rows: [...existingStatement.rows, ...read.value.rows],
        skipped: [...existingStatement.skipped, ...read.value.skipped],
        isins: Array.from(new Set([...existingStatement.isins, ...read.value.isins])),
        isin: null,
      }
    : read.value;
  if (combinedStatement.isins.length === 1) {
    combinedStatement.isin = combinedStatement.isins[0]!;
  }
  const preview = await buildStatementImportPreview(
    store.agentView,
    combinedStatement,
    resolver,
  );
  if (!preview.ok) return { ok: false, error: preview.message };

  const proposal =
    existing ?? (await store.assistantProposals.create({ kind: "statement_import" }));
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: parsed.value.documentName ?? `${parsed.value.broker}.csv`,
      provenance: "agent",
      sha256: createHash("sha256").update(parsed.value.rawText).digest("hex"),
    },
    facts: read.value.rows,
  });

  return {
    ok: true,
    proposal: {
      proposalType: "statement_import",
      draft: { proposalId: proposal.id },
      funds: preview.funds,
    },
  };
}

/** Pilot (#766): include every fund shown in the preview — no per-fund LLM selection. */
export function selectionsFromPreviewFunds(
  buckets: StatementImportBucket[],
  previewFunds: FundPreviewRow[],
  ownership: OwnershipShare[],
  seed: number,
): StatementFundSelection[] {
  const previewByIsin = new Map(previewFunds.map((fund) => [fund.isin, fund]));

  return buckets.map((bucket, index) => {
    if (bucket.bucket === "matched") {
      return { action: "include", isin: bucket.isin } as const;
    }

    const preview = previewByIsin.get(bucket.isin);
    const instrument = bucket.instrument ?? "fund";
    const defaults = defaultsFor(instrument);
    const name =
      (preview?.bucket === "new" ? preview.suggestedName : undefined) ||
      bucket.name ||
      bucket.isin;
    const symbol = preview?.bucket === "new" ? (preview.suggestedSymbol ?? "") : "";

    return {
      action: "include",
      creation: {
        assetId: createStableId("asset", name, seed + index),
        currency: "EUR",
        instrument,
        liquidityTier: defaults.rung,
        name,
        ownership,
        ...(symbol
          ? {
              priceProvider: defaults.priceProvider as InvestmentPriceProvider,
              providerSymbol: symbol,
            }
          : {}),
      },
      isin: bucket.isin,
    } as const;
  });
}

export type { StatementFundSelection };
