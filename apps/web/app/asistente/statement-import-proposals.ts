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
import type {
  OwnershipShare,
  StatementBroker,
  StatementFundSelection,
  StatementImportBucket,
} from "@worthline/domain";
import { defaultsFor, type InvestmentPriceProvider } from "@worthline/domain";

export interface StatementImportProposalDraft {
  broker: StatementBroker;
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

const MAX_RAW_TEXT_CHARS = 500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

  return {
    ok: true,
    draft: { broker, rawText },
  };
}

export async function buildStatementImportProposal(
  store: StatementImportPreviewReadPort,
  rawDraft: unknown,
  resolver: IsinSymbolResolver = defaultIsinSymbolResolver,
): Promise<StatementImportProposalBuildResult> {
  const parsed = parseStatementImportProposalDraft(rawDraft);
  if (!parsed.ok) return parsed;

  const read = readStatementFromText(parsed.draft.rawText, parsed.draft.broker);
  if (!read.ok) return { ok: false, error: read.message };

  const preview = await buildStatementImportPreview(store, read.value, resolver);
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
