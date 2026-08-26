import type { PropertyAcquisitionArgs } from "@web/asistente/property-acquisition-proposals";
import { jsonSchema } from "ai";

/**
 * Input schemas for the housing family: the two anchors a proposal can move.
 *
 * They live together because ADR 0086 splits proposal schemas per FAMILY, and
 * these two are one — even though their provenance is opposite, which is the whole
 * distinction between them. The valuation anchor points at a document worthline
 * already extracted, so its figures are not the model's. The acquisition's are: a
 * date and a price the person says out loud («lo compré en mayo de 2004 por
 * 150.253 €»), which is the single fact the unvalidated-evidence frontier admits
 * (#1248) precisely because the preview shows it back for a human to check.
 *
 * Note what the acquisition does NOT declare: a `summary`. See
 * {@link PropertyAcquisitionArgs} for why.
 */

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

export const PROPERTY_ACQUISITION_PROPOSAL_SCHEMA = jsonSchema<
  Partial<PropertyAcquisitionArgs>
>({
  type: "object",
  properties: {
    assetId: { type: "string" },
    acquisitionDate: { type: "string" },
    acquisitionValueMinor: { type: "integer" },
  },
  required: ["assetId", "acquisitionDate", "acquisitionValueMinor"],
  additionalProperties: false,
});
