import type { CorrectionInput } from "@web/asistente/correction-proposals";
import type { HoldingCreationArgs } from "@web/asistente/holding-creation-proposals";
import { PROPOSAL_SUMMARY_MAX_CHARS } from "@web/asistente/proposal-summary";
import { jsonSchema } from "ai";

/**
 * Input schemas for the manual-tracking families: the alta «por estado actual»,
 * the correction of one badly modelled holding, and the reversible baja/restore
 * pair over the papelera.
 *
 * Two of them declare a DOMAIN type — `HoldingCreationArgs`, `CorrectionInput` —
 * so the builder receives what the schema promised instead of a record the tool
 * casts on its way in.
 */

export const HOLDING_CREATION_PROPOSAL_SCHEMA = jsonSchema<HoldingCreationArgs>({
  type: "object",
  properties: {
    family: {
      type: "string",
      enum: ["stored", "appreciating", "debt", "investment"],
    },
    name: { type: "string" },
    instrument: {
      type: "string",
      enum: [
        "current_account",
        "term_deposit",
        "precious_metal",
        "vehicle",
        "other",
        "property",
        "mortgage",
        "loan",
        "credit_card",
        "fund",
        "etf",
        "stock",
        "index",
        "pension_plan",
        "crypto",
      ],
    },
    currentValueMinor: { type: "integer" },
    isPrimaryResidence: { type: "boolean" },
    acquisitionDate: { type: "string" },
    acquisitionValueMinor: { type: "integer" },
    balanceMinor: { type: "integer" },
    debtModel: { type: "string", enum: ["amortizable", "revolving", "informal"] },
    providerSymbol: { type: "string" },
    isin: { type: "string" },
    openingValueMinor: { type: "integer" },
    pricePerUnit: { type: "string" },
    units: { type: "string" },
    feesMinor: { type: "integer" },
  },
  required: ["family", "name", "instrument"],
  additionalProperties: false,
});

/**
 * The correction, declared as the DOMAIN type the builder takes: the JSON schema
 * below and {@link CorrectionInput} are the same five kinds, so the tool hands
 * `correction` straight over instead of casting it through `unknown`.
 *
 * A declaration, NOT a validation: `jsonSchema()` is created without a `validate`,
 * so the JSON body below is a hint to the model and nothing enforces it at the tool
 * boundary. What makes the type true is `buildCorrectionProposal`, which checks each
 * branch's own fields (`!Number.isFinite(correction.balanceMinor)` and its siblings)
 * and refuses with a message naming what is missing. Widen a branch here and that
 * check is what has to grow with it.
 */
export const CORRECTION_PROPOSAL_SCHEMA = jsonSchema<{
  holdingId?: string;
  summary?: string;
  correction?: CorrectionInput;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
    correction: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "declare_balance",
            "declare_value",
            "change_debt_model",
            "edit_config",
            "edit_identity",
          ],
        },
        balanceMinor: { type: "number" },
        valueMinor: { type: "number" },
        date: { type: "string" },
        endDate: { type: "string" },
        monthlyPaymentMinor: { type: "number" },
        annualRate: { type: "string" },
        debtModel: { type: "string", enum: ["amortizable", "revolving", "informal"] },
        name: { type: "string" },
        ownership: {
          type: "array",
          items: {
            type: "object",
            properties: {
              memberId: { type: "string" },
              shareBps: { type: "number" },
            },
            required: ["memberId", "shareBps"],
            additionalProperties: false,
          },
        },
        cadence: { type: ["string", "null"], enum: ["step", "interpolated", null] },
        isin: { type: "string" },
        providerSymbol: { type: "string" },
        plan: {
          type: "object",
          properties: {
            annualInterestRate: { type: "string" },
            termMonths: { type: "number" },
            firstPaymentDate: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  required: ["holdingId", "correction"],
  additionalProperties: false,
});

export const HOLDING_TRASH_PROPOSAL_SCHEMA = jsonSchema<{
  holdingIds?: string[];
  summary?: string;
}>({
  type: "object",
  properties: {
    holdingIds: { type: "array", items: { type: "string" } },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
  },
  required: ["holdingIds"],
  additionalProperties: false,
});
