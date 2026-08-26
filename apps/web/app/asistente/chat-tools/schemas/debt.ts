import { PROPOSAL_SUMMARY_MAX_CHARS } from "@web/asistente/proposal-summary";
import type { ReconstructionAmendmentOperation } from "@web/asistente/reconstruction-amendment";
import { jsonSchema } from "ai";

/**
 * Input schemas for the debt families: the observed-balance series (import and
 * reconstruction), the amendment that edits an open reconstruction, and the
 * early repayment.
 *
 * None of them takes a rate, a term or an instalment: the app re-derives the curve
 * from the observed balances, so a schema that accepted them would be inviting the
 * model to infer what the engine computes.
 */

export const BALANCE_HISTORY_PROPOSAL_SCHEMA = jsonSchema<{
  liabilityId?: string;
  documentName?: string;
  rows?: Array<{ date: string; balanceMinor: number; annualRate?: string }>;
}>({
  type: "object",
  properties: {
    liabilityId: { type: "string" },
    documentName: { type: "string" },
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
  required: ["liabilityId", "rows"],
  additionalProperties: false,
});

export const RECONSTRUCTION_PROPOSAL_SCHEMA = jsonSchema<{
  holdingId?: string;
  summary?: string;
  documentName?: string;
  rows?: Array<{ date: string; balanceMinor: number }>;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
    documentName: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          balanceMinor: { type: "number" },
        },
        required: ["date", "balanceMinor"],
        additionalProperties: false,
      },
    },
  },
  required: ["holdingId", "rows"],
  additionalProperties: false,
});

/**
 * Enmendar la reconstrucción abierta (#1423). Deliberadamente CHATO y de dos
 * campos: el fallo que arregla es que reemitir 49 filas en una tool call es la
 * carga que `gemini-3.1-flash-lite` deja de producir —narrando «he actualizado la
 * propuesta» sin llamar a nada—, así que la enmienda no vuelve a pedir la serie.
 */
export const RECONSTRUCTION_AMENDMENT_SCHEMA = jsonSchema<{
  proposalId?: string;
  summary?: string;
  operations?: ReconstructionAmendmentOperation[];
}>({
  type: "object",
  properties: {
    proposalId: { type: "string" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { enum: ["exclude", "include", "set_balance"], type: "string" },
          date: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          balanceMinor: { type: "number" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposalId", "operations"],
  additionalProperties: false,
});

export const EARLY_REPAYMENT_PROPOSAL_SCHEMA = jsonSchema<{
  liabilityId?: string;
  repaymentDate?: string;
  amountMinor?: number;
  mode?: "reduce-payment" | "reduce-term";
  observedMonthlyPaymentMinor?: number;
  summary?: string;
}>({
  type: "object",
  properties: {
    liabilityId: { type: "string" },
    repaymentDate: { type: "string" },
    amountMinor: { type: "integer" },
    mode: { enum: ["reduce-payment", "reduce-term"], type: "string" },
    observedMonthlyPaymentMinor: { type: "integer" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
  },
  required: ["liabilityId", "repaymentDate", "amountMinor", "mode"],
  additionalProperties: false,
});
