import { PROPOSAL_SUMMARY_MAX_CHARS } from "@web/asistente/proposal-summary";
import type { MaintainerAlertCategory } from "@worthline/db";
import { jsonSchema } from "ai";

/** Input schema for the maintainer-only forensic alert (#1050, ADR 0064). */

export const RAISE_MAINTAINER_ALERT_SCHEMA = jsonSchema<{
  holdingId: string;
  category: MaintainerAlertCategory;
  summary: string;
  declaredBalanceMinor?: number;
  declaredDate?: string;
  declaredSource?: string;
  extractedData?: Record<string, unknown>;
  conversationRef?: string;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    category: { enum: ["infidelity", "residual", "sync_source"], type: "string" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
    declaredBalanceMinor: { type: "integer" },
    declaredDate: { type: "string" },
    declaredSource: { type: "string" },
    extractedData: { type: "object", additionalProperties: true },
    conversationRef: { type: "string" },
  },
  required: ["holdingId", "category", "summary"],
  additionalProperties: false,
});
