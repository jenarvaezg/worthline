import type { ParsedStatementRow } from "@worthline/domain";
import { and, asc, eq, max } from "drizzle-orm";

import type { CorrectionPlan } from "./correction-plan";
import type { HoldingCreationPlan } from "./holding-creation-plan";
import {
  type AssistantDocumentProvenance,
  type AssistantProposalKind,
  type AssistantProposalStatus,
  assistantProposalDocuments,
  assistantProposalFacts,
  assistantProposals,
} from "./schema";
import type { StoreContext } from "./store-context";

export interface AssistantProposalDocumentRef {
  name: string;
  sha256: string;
  provenance: AssistantDocumentProvenance;
}

export interface StatementOperationFact {
  kind: "statement_operation";
  row: ParsedStatementRow;
}

export interface DebtBalanceObservationFact {
  kind: "debt_balance_observation";
  row: { liabilityId: string; date: string; balanceMinor: number; annualRate?: string };
}

export interface PropertyValuationAnchorFact {
  kind: "property_valuation_anchor";
  row: { assetId: string; valuationDate: string; valueMinor: number };
}

/**
 * A whole correction plan (#1051) stored as one self-contained fact: the target
 * holding, mode, ordered edits and their before-values. Unlike the import facts,
 * it is not extracted from a document — it is a chat-declared, previewable diff.
 */
export interface HoldingCorrectionFact {
  kind: "holding_correction";
  row: CorrectionPlan;
}

/**
 * A whole holding-creation plan (#1105) stored as one self-contained fact: the
 * resolved alta "por estado actual" (family + declared value/balance + ownership).
 * Like {@link HoldingCorrectionFact} it is chat-declared, not document-extracted;
 * the confirm reconstructs the write purely from this row.
 */
export interface HoldingCreationFact {
  kind: "holding_creation";
  row: HoldingCreationPlan;
}

export type AssistantProposalFact =
  | StatementOperationFact
  | DebtBalanceObservationFact
  | PropertyValuationAnchorFact
  | HoldingCorrectionFact
  | HoldingCreationFact;

export interface AssistantProposalDocument {
  id: string;
  document: AssistantProposalDocumentRef;
  facts: AssistantProposalFact[];
}

export interface AssistantProposal {
  id: string;
  kind: AssistantProposalKind;
  status: AssistantProposalStatus;
  documents: AssistantProposalDocument[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface AppendAssistantProposalDocumentInput {
  document: AssistantProposalDocumentRef;
  facts: ReadonlyArray<ParsedStatementRow | AssistantProposalFact>;
}

export interface AssistantProposalStore {
  create: (input: { kind: AssistantProposalKind }) => Promise<AssistantProposal>;
  appendDocument: (
    proposalId: string,
    input: AppendAssistantProposalDocumentInput,
  ) => Promise<AssistantProposal>;
  read: (proposalId: string) => Promise<AssistantProposal | null>;
  markApplied: (proposalId: string) => Promise<AssistantProposal>;
  markDiscarded: (proposalId: string) => Promise<AssistantProposal>;
}

export function createAssistantProposalStore(ctx: StoreContext): AssistantProposalStore {
  return {
    create: (input) => createProposal(ctx, input),
    appendDocument: (proposalId, input) => appendDocument(ctx, proposalId, input),
    read: (proposalId) => readProposal(ctx, proposalId),
    markApplied: (proposalId) => resolveProposal(ctx, proposalId, "applied"),
    markDiscarded: (proposalId) => resolveProposal(ctx, proposalId, "discarded"),
  };
}

async function createProposal(
  ctx: StoreContext,
  input: { kind: AssistantProposalKind },
): Promise<AssistantProposal> {
  if (
    input.kind !== "statement_import" &&
    input.kind !== "balance_history_import" &&
    input.kind !== "property_valuation_anchor" &&
    input.kind !== "mixed_document_import" &&
    input.kind !== "correction" &&
    input.kind !== "holding_creation"
  ) {
    throw new Error(`Unsupported assistant proposal kind: ${String(input.kind)}`);
  }
  const now = new Date().toISOString();
  const id = ctx.newId();
  await ctx.db.insert(assistantProposals).values({
    createdAt: now,
    id,
    kind: input.kind,
    status: "draft",
    updatedAt: now,
  });
  return requiredProposal(await readProposal(ctx, id), id);
}

function normalizeFact(
  fact: ParsedStatementRow | AssistantProposalFact,
): AssistantProposalFact {
  if (fact.kind === "holding_correction" && "row" in fact) {
    return { kind: fact.kind, row: fact.row };
  }
  if (fact.kind === "holding_creation" && "row" in fact) {
    return { kind: fact.kind, row: fact.row };
  }
  if (fact.kind === "property_valuation_anchor" && "row" in fact) {
    return {
      kind: fact.kind,
      row: {
        assetId: fact.row.assetId,
        valuationDate: fact.row.valuationDate,
        valueMinor: fact.row.valueMinor,
      },
    };
  }
  if (fact.kind === "debt_balance_observation" && "row" in fact) {
    return {
      kind: fact.kind,
      row: {
        balanceMinor: fact.row.balanceMinor,
        date: fact.row.date,
        liabilityId: fact.row.liabilityId,
        ...(fact.row.annualRate === undefined ? {} : { annualRate: fact.row.annualRate }),
      },
    };
  }
  const row =
    fact.kind === "statement_operation" && "row" in fact
      ? fact.row
      : (fact as ParsedStatementRow);
  return {
    kind: "statement_operation",
    row: {
      currency: row.currency,
      dateKey: row.dateKey,
      feesMinor: row.feesMinor,
      isin: row.isin,
      kind: row.kind,
      pricePerUnit: row.pricePerUnit,
      units: row.units,
      ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
      ...(row.instrument === undefined ? {} : { instrument: row.instrument }),
      ...(row.name === undefined ? {} : { name: row.name }),
    },
  };
}

function assertDocument(input: AssistantProposalDocumentRef): void {
  if (input.name.trim().length === 0) throw new Error("Document name is required.");
  if (!/^[a-fA-F0-9]{64}$/.test(input.sha256)) {
    throw new Error("Document SHA-256 must be a 64-character hexadecimal hash.");
  }
  if (input.provenance !== "agent" && input.provenance !== "user") {
    throw new Error("Document provenance must be agent or user.");
  }
}

async function appendDocument(
  ctx: StoreContext,
  proposalId: string,
  input: AppendAssistantProposalDocumentInput,
): Promise<AssistantProposal> {
  assertDocument(input.document);
  await ctx.transaction(async () => {
    const proposal = await ctx.db
      .select({ status: assistantProposals.status })
      .from(assistantProposals)
      .where(eq(assistantProposals.id, proposalId))
      .get();
    if (!proposal) throw new Error(`Assistant proposal "${proposalId}" was not found.`);
    assertDraft(proposalId, proposal.status);

    const sequenceRow = await ctx.db
      .select({ value: max(assistantProposalDocuments.sequence) })
      .from(assistantProposalDocuments)
      .where(eq(assistantProposalDocuments.proposalId, proposalId))
      .get();
    const documentId = ctx.newId();
    await ctx.db.insert(assistantProposalDocuments).values({
      id: documentId,
      name: input.document.name,
      proposalId,
      provenance: input.document.provenance,
      sequence: (sequenceRow?.value ?? -1) + 1,
      sha256: input.document.sha256.toLowerCase(),
    });

    const facts = input.facts.map(normalizeFact);
    if (facts.length > 0) {
      await ctx.db.insert(assistantProposalFacts).values(
        facts.map((fact, ordinal) => ({
          documentId,
          id: ctx.newId(),
          kind: fact.kind,
          ordinal,
          payloadJson: JSON.stringify(fact.row),
        })),
      );
    }
    await ctx.db
      .update(assistantProposals)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(assistantProposals.id, proposalId))
      .run();
  });
  return requiredProposal(await readProposal(ctx, proposalId), proposalId);
}

async function readProposal(
  ctx: StoreContext,
  proposalId: string,
): Promise<AssistantProposal | null> {
  const proposal = await ctx.db
    .select()
    .from(assistantProposals)
    .where(eq(assistantProposals.id, proposalId))
    .get();
  if (!proposal) return null;

  const documents = await ctx.db
    .select()
    .from(assistantProposalDocuments)
    .where(eq(assistantProposalDocuments.proposalId, proposalId))
    .orderBy(asc(assistantProposalDocuments.sequence))
    .all();
  const resultDocuments: AssistantProposalDocument[] = [];
  for (const document of documents) {
    const facts = await ctx.db
      .select()
      .from(assistantProposalFacts)
      .where(eq(assistantProposalFacts.documentId, document.id))
      .orderBy(asc(assistantProposalFacts.ordinal))
      .all();
    resultDocuments.push({
      document: {
        name: document.name,
        provenance: document.provenance,
        sha256: document.sha256,
      },
      facts: facts.map((fact) => {
        if (
          fact.kind !== "statement_operation" &&
          fact.kind !== "debt_balance_observation" &&
          fact.kind !== "property_valuation_anchor" &&
          fact.kind !== "holding_correction" &&
          fact.kind !== "holding_creation"
        ) {
          throw new Error(`Unsupported assistant proposal fact kind: ${fact.kind}`);
        }
        if (fact.kind === "holding_correction") {
          return {
            kind: fact.kind,
            row: JSON.parse(fact.payloadJson) as HoldingCorrectionFact["row"],
          };
        }
        if (fact.kind === "holding_creation") {
          return {
            kind: fact.kind,
            row: JSON.parse(fact.payloadJson) as HoldingCreationFact["row"],
          };
        }
        if (fact.kind === "debt_balance_observation") {
          return {
            kind: fact.kind,
            row: JSON.parse(fact.payloadJson) as DebtBalanceObservationFact["row"],
          };
        }
        if (fact.kind === "property_valuation_anchor") {
          return {
            kind: fact.kind,
            row: JSON.parse(fact.payloadJson) as PropertyValuationAnchorFact["row"],
          };
        }
        return {
          kind: "statement_operation",
          row: JSON.parse(fact.payloadJson) as ParsedStatementRow,
        };
      }),
      id: document.id,
    });
  }

  return {
    createdAt: proposal.createdAt,
    documents: resultDocuments,
    id: proposal.id,
    kind: proposal.kind,
    ...(proposal.resolvedAt ? { resolvedAt: proposal.resolvedAt } : {}),
    status: proposal.status,
    updatedAt: proposal.updatedAt,
  };
}

async function resolveProposal(
  ctx: StoreContext,
  proposalId: string,
  status: Exclude<AssistantProposalStatus, "draft">,
): Promise<AssistantProposal> {
  const now = new Date().toISOString();
  const result = await ctx.db
    .update(assistantProposals)
    .set({ resolvedAt: now, status, updatedAt: now })
    // One guarded write makes terminal resolution atomic, including concurrent callers.
    .where(
      and(eq(assistantProposals.id, proposalId), eq(assistantProposals.status, "draft")),
    )
    .run();
  if (result.rowsAffected === 0) {
    const existing = await readProposal(ctx, proposalId);
    if (existing) assertDraft(proposalId, existing.status);
    throw new Error(`Assistant proposal "${proposalId}" was not found.`);
  }

  const resolved = requiredProposal(await readProposal(ctx, proposalId), proposalId);
  return resolved;
}

function assertDraft(proposalId: string, status: AssistantProposalStatus): void {
  if (status !== "draft") {
    throw new Error(
      `Assistant proposal "${proposalId}" is already resolved as ${status}.`,
    );
  }
}

function requiredProposal(
  proposal: AssistantProposal | null,
  proposalId: string,
): AssistantProposal {
  if (!proposal) throw new Error(`Assistant proposal "${proposalId}" was not found.`);
  return proposal;
}
