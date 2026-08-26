import { PROPOSAL_SUMMARY_MAX_CHARS } from "@web/asistente/proposal-summary";
import { jsonSchema } from "ai";

/**
 * Input schemas for the document-ingestion families: the broker statement, the
 * mixed document, the portfolio reconcile and the property-valuation anchor.
 *
 * What they share is that the FIGURES are not theirs. Each one either points at a
 * document worthline already extracted and validated, or hands over raw text the
 * app parses itself — so the fields here name rows, they do not carry them.
 */

export const STATEMENT_IMPORT_PROPOSAL_SCHEMA = jsonSchema<{
  broker?: string;
  documentName?: string;
  proposalId?: string;
  rawText?: string;
}>({
  type: "object",
  properties: {
    broker: { type: "string" },
    documentName: { type: "string" },
    proposalId: { type: "string" },
    rawText: { type: "string" },
  },
  // No required field since #1487: a call standing on a validated transactions document
  // passes nothing at all, and demanding `rawText` would force the model to retype the
  // very figures this lane exists to keep it away from.
  additionalProperties: false,
});

/**
 * One segment the model classified (ADR 0059), typed by `kind` so the tool reads
 * the holding reference off the branch that has one instead of indexing a record
 * and casting the result to a string.
 *
 * A declaration, NOT a validation, for the same reason as the correction schema:
 * `buildMixedDocumentProposal` takes the segments as `unknown` and does the real
 * classification check itself, refusing an ambiguous one by index.
 */
export type MixedDocumentSegmentArg =
  | {
      kind: "investment_statement";
      confidence: "certain" | "uncertain";
      broker?: string;
      rawText?: string;
    }
  | {
      kind: "debt_balance_history";
      confidence: "certain" | "uncertain";
      liabilityId?: string;
      rows?: Array<{ date: string; balanceMinor: number; annualRate?: string }>;
    }
  | {
      kind: "property_valuation";
      confidence: "certain" | "uncertain";
      assetId?: string;
      valuationDate?: string;
      valueMinor?: number;
    };

export const MIXED_DOCUMENT_PROPOSAL_SCHEMA = jsonSchema<{
  documentName?: string;
  documentSha256?: string;
  segments?: MixedDocumentSegmentArg[];
}>({
  type: "object",
  properties: {
    documentName: { type: "string" },
    documentSha256: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            enum: ["investment_statement", "debt_balance_history", "property_valuation"],
            type: "string",
          },
          confidence: { enum: ["certain", "uncertain"], type: "string" },
          broker: { type: "string" },
          rawText: { type: "string" },
          liabilityId: { type: "string" },
          assetId: { type: "string" },
          valuationDate: { type: "string" },
          valueMinor: { type: "number" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                balanceMinor: { type: "number" },
                annualRate: { type: "string" },
              },
              required: ["date", "balanceMinor"],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["documentName", "documentSha256", "segments"],
  additionalProperties: false,
});

/**
 * A reconcile is a SELECTION over a document worthline validated, not a batch of
 * rows the model writes (#1373). So `holdings` only has to point at rows — a name
 * and/or an ISIN — and every figure comes from the extraction.
 *
 * What the fields that are still accepted are doing here: `value` used to be
 * MANDATORY, which is what pushed a model holding an aportación confirmation (a
 * document with no position value in it at all) to fill the slot with a portfolio
 * snapshot; it is now optional and only ever used to CHECK the pick. `type`,
 * `currency`, `fidelity`, `declaredCost`, `uncertain` and `movements` are tolerated
 * so a model still relaying the old shape does not fail its call, and ignored: the
 * app has the extractor's own values and never needs the model's copy of them.
 */
export const RECONCILE_PROPOSAL_SCHEMA = jsonSchema<{
  documentName?: string;
  holdings?: Array<Record<string, unknown>>;
  movements?: Array<Record<string, unknown>>;
}>({
  type: "object",
  properties: {
    documentName: { type: "string" },
    holdings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          isin: { type: "string" },
          value: { type: "number" },
          currency: { type: "string" },
          declaredCost: { type: "number" },
          fidelity: {
            enum: ["movements", "declared_cost", "value_only"],
            type: "string",
          },
          uncertain: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    movements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          kind: { enum: ["buy", "sell", "contribution"], type: "string" },
          isin: { type: "string" },
          name: { type: "string" },
          units: { type: "number" },
          amount: { type: "number" },
          currency: { type: "string" },
          uncertain: { type: "boolean" },
        },
        required: ["date", "kind", "amount", "currency"],
        additionalProperties: false,
      },
    },
  },
  required: ["holdings"],
  additionalProperties: false,
});

export const PROPERTY_VALUATION_PROPOSAL_SCHEMA = jsonSchema<{
  assetId?: string;
  documentName?: string;
  documentSha256?: string;
  valuationDate?: string;
  valueMinor?: number;
}>({
  type: "object",
  properties: {
    assetId: { type: "string" },
    documentName: { type: "string" },
    documentSha256: { type: "string" },
    valuationDate: { type: "string" },
    valueMinor: { type: "integer" },
  },
  required: ["assetId", "documentName", "documentSha256", "valuationDate", "valueMinor"],
  additionalProperties: false,
});
