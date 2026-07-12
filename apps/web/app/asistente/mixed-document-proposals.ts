import { parseBalanceHistoryRows } from "@web/patrimonio/import-balance-history";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  type FundPreviewRow,
  type IsinSymbolResolver,
  parseStatementBroker,
  readStatementFromText,
} from "@web/patrimonio/importar-extracto/statement-import-preview";
import type {
  AssistantProposalFact,
  AssistantProposalStore,
  WorthlineStore,
} from "@worthline/db";
import { type ParsedStatementRow, valueHousingAtDate } from "@worthline/domain";
import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import { parsePropertyValuationAnchorInput } from "./property-valuation-proposals";

type MixedProposalStore = Pick<WorthlineStore, "agentView" | "assets" | "liabilities"> & {
  assistantProposals: AssistantProposalStore;
};

type SegmentRecord = Record<string, unknown>;

export type MixedTrust = {
  tier: "reconciled" | "unverified" | "mismatch";
  requiresReview: boolean;
};

export type MixedDocumentSection =
  | {
      kind: "investment_statement";
      assetKey: string;
      preview: {
        funds: FundPreviewRow[];
        reconciliation: {
          matches: boolean;
          positionImpact: FundPreviewRow["positionImpact"];
        };
        trust: MixedTrust;
      };
    }
  | {
      kind: "debt_balance_history";
      assetKey: string;
      preview: {
        curve: Array<{ balanceMinor: number; date: string }>;
        liability: { id: string; name: string };
        points: Array<{
          balanceMinor: number;
          date: string;
          driftMinor: number | null;
          reason?: string;
          status: "accepted" | "skipped" | "excluded";
        }>;
        reconciliation: {
          expectedMinor: number;
          matches: boolean;
          resultingMinor: number;
        };
        trust: MixedTrust;
      };
    }
  | {
      kind: "property_valuation";
      assetKey: string;
      preview: {
        anchors: Array<{ assetId: string; valuationDate: string; valueMinor: number }>;
        curve: Array<{ date: string; valueMinor: number }>;
        property: { id: string; name: string };
        trust: MixedTrust;
      };
    };

export type MixedDocumentProposal = {
  proposalType: "mixed_document_import";
  draft: { proposalId: string };
  sections: MixedDocumentSection[];
};

function isRecord(value: unknown): value is SegmentRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ambiguityMessage(index: number): string {
  return `El segmento ${index + 1} tiene una clasificación dudosa. Pregunta al usuario antes de proponer cambios.`;
}

/**
 * Classify-then-extract boundary for ADR 0059. The model supplies segment
 * boundaries and an explicit certain classification; this function never
 * guesses. Each segment is then routed through the existing typed S1/S5/S6
 * projector before a single mixed proposal is persisted.
 */
export async function buildMixedDocumentProposal(
  store: MixedProposalStore,
  raw: unknown,
  today: string,
  resolver: IsinSymbolResolver = defaultIsinSymbolResolver,
): Promise<{ ok: true; proposal: MixedDocumentProposal } | { ok: false; error: string }> {
  if (!isRecord(raw) || !Array.isArray(raw.segments) || raw.segments.length === 0) {
    return { ok: false, error: "El documento no contiene segmentos clasificados." };
  }
  if (
    typeof raw.documentName !== "string" ||
    !raw.documentName.trim() ||
    typeof raw.documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(raw.documentSha256)
  ) {
    return { ok: false, error: "Faltan el nombre o la huella SHA-256 del documento." };
  }

  const investmentRows: ParsedStatementRow[] = [];
  const debtGroups = new Map<
    string,
    Array<{ date: string; balanceMinor: number; annualRate?: string }>
  >();
  const propertyGroups = new Map<
    string,
    Array<{ assetId: string; valuationDate: string; valueMinor: number }>
  >();
  const facts: AssistantProposalFact[] = [];
  for (const [index, value] of raw.segments.entries()) {
    if (!isRecord(value) || value.confidence !== "certain") {
      return { ok: false, error: ambiguityMessage(index) };
    }
    if (value.kind === "investment_statement") {
      const broker = parseStatementBroker(value.broker ?? "plantilla");
      if (!broker || typeof value.rawText !== "string") {
        return { ok: false, error: ambiguityMessage(index) };
      }
      const statement = readStatementFromText(value.rawText, broker);
      if (!statement.ok) return { ok: false, error: statement.message };
      investmentRows.push(...statement.value.rows);
      facts.push(
        ...statement.value.rows.map((row) => ({
          kind: "statement_operation" as const,
          row,
        })),
      );
      continue;
    }
    if (value.kind === "debt_balance_history") {
      if (typeof value.liabilityId !== "string") {
        return { ok: false, error: ambiguityMessage(index) };
      }
      const parsedRows = parseBalanceHistoryRows(value.rows);
      if (!parsedRows.ok) return parsedRows;
      debtGroups.set(value.liabilityId, [
        ...(debtGroups.get(value.liabilityId) ?? []),
        ...parsedRows.rows,
      ]);
      facts.push(
        ...parsedRows.rows.map((row) => ({
          kind: "debt_balance_observation" as const,
          row: { liabilityId: value.liabilityId as string, ...row },
        })),
      );
      continue;
    }
    if (value.kind === "property_valuation") {
      const parsed = parsePropertyValuationAnchorInput(value, today);
      if (!parsed.ok) return parsed;
      propertyGroups.set(parsed.row.assetId, [
        ...(propertyGroups.get(parsed.row.assetId) ?? []),
        parsed.row,
      ]);
      facts.push({ kind: "property_valuation_anchor", row: parsed.row });
      continue;
    }
    return { ok: false, error: ambiguityMessage(index) };
  }

  const sections: MixedDocumentProposal["sections"] = [];
  if (investmentRows.length > 0) {
    const isins = Array.from(
      new Set(investmentRows.flatMap((row) => (row.isin ? [row.isin] : []))),
    );
    const preview = await buildStatementImportPreview(
      store.agentView,
      {
        directionResolved: true,
        isin: isins.length === 1 ? isins[0]! : null,
        isins,
        rows: investmentRows,
        skipped: [],
      },
      resolver,
    );
    if (!preview.ok) return { ok: false, error: preview.message };
    for (const fund of preview.funds) {
      const reconciliation = {
        matches: fund.positionImpact.flags.length === 0,
        positionImpact: fund.positionImpact,
      };
      sections.push({
        assetKey: fund.isin,
        kind: "investment_statement",
        preview: {
          funds: [fund],
          reconciliation,
          trust: {
            requiresReview: fund.bucket !== "matched" || !reconciliation.matches,
            tier:
              fund.bucket === "matched" && reconciliation.matches
                ? "reconciled"
                : "unverified",
          },
        },
      });
    }
  }

  for (const [liabilityId, rows] of debtGroups) {
    const projected = await projectBalanceHistoryProposal(
      store,
      liabilityId,
      rows,
      today,
    );
    if (!projected.ok) return projected;
    sections.push({
      assetKey: liabilityId,
      kind: "debt_balance_history",
      preview: {
        curve: projected.curve,
        liability: { id: projected.liability.id, name: projected.liability.name },
        points: projected.plan.previews,
        reconciliation: projected.reconciliation,
        trust: {
          requiresReview: !projected.reconciliation.matches,
          tier: projected.reconciliation.matches ? "reconciled" : "mismatch",
        },
      },
    });
  }

  const assets = propertyGroups.size > 0 ? await store.assets.readAssets() : [];
  for (const [assetId, proposed] of propertyGroups) {
    const property = assets.find(
      (asset) => asset.id === assetId && asset.type === "real_estate",
    );
    if (!property) return { ok: false, error: "El inmueble no existe." };
    const existing = await store.assets.readValuationAnchors(assetId);
    const dates = proposed.map((anchor) => anchor.valuationDate);
    if (
      new Set(dates).size !== dates.length ||
      dates.some((date) => existing.some((anchor) => anchor.valuationDate === date))
    ) {
      return { ok: false, error: "Ya existe una valoración en esa fecha." };
    }
    const annualAppreciationRate = await store.assets.readAnnualAppreciationRate(assetId);
    const proposedCurveAnchors = proposed.map((anchor) => ({
      adjustsPriorCurve: true,
      valuationDate: anchor.valuationDate,
      valueMinor: anchor.valueMinor,
    }));
    const curveDates = Array.from(
      new Set([...existing.map((anchor) => anchor.valuationDate), ...dates, today]),
    ).sort();
    sections.push({
      assetKey: assetId,
      kind: "property_valuation",
      preview: {
        anchors: proposed,
        curve: curveDates.map((date) => ({
          date,
          valueMinor: valueHousingAtDate({
            anchors: [...existing, ...proposedCurveAnchors],
            annualAppreciationRate,
            currentValueMinor: property.currentValue.amountMinor,
            targetDate: date,
            today,
          }),
        })),
        property: { id: property.id, name: property.name },
        trust: { requiresReview: true, tier: "unverified" },
      },
    });
  }

  const proposal = await store.assistantProposals.create({
    kind: "mixed_document_import",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: raw.documentName.trim().slice(0, 255),
      provenance: "agent",
      sha256: raw.documentSha256,
    },
    facts,
  });
  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      proposalType: "mixed_document_import",
      sections,
    },
  };
}
