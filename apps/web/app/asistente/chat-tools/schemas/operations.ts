import type { OperationKindClaim } from "@web/asistente/operation-document-frontier";
import { PROPOSAL_SUMMARY_MAX_CHARS } from "@web/asistente/proposal-summary";
import { jsonSchema } from "ai";

/**
 * Input schemas for the dated-movement families: one operation against its
 * justificante, and one traspaso between two existing investments.
 */

/**
 * `propose_operation` (#1374). The holding and the DIRECTION are the model's calls —
 * nothing in a document says which of the user's positions a paper belongs to, and a
 * securities confirmation lands as a generic dated fact — and everything else is a
 * CLAIM about the validated extraction, checked against it and then discarded. So the
 * position's current value is not a field at all: nobody has to fill it, which is the
 * whole point (the improvised reconcile demanded it and got a portfolio snapshot).
 *
 * `pricePerUnit` and `fees` are accepted in the document's major units, like `amount`,
 * because they are relayed for verification and never persisted from here — unlike
 * every céntimos-taking tool, this one takes no money it will write.
 */
export const OPERATION_PROPOSAL_SCHEMA = jsonSchema<{
  holdingId?: string;
  kind?: OperationKindClaim;
  date?: string;
  amount?: number;
  currency?: string;
  isin?: string;
  units?: number;
  pricePerUnit?: number;
  fees?: number;
  summary?: string;
}>({
  type: "object",
  properties: {
    holdingId: { type: "string" },
    kind: { enum: ["buy", "sell", "contribution"], type: "string" },
    date: { type: "string" },
    amount: { type: "number" },
    currency: { type: "string" },
    isin: { type: "string" },
    units: { type: "number" },
    pricePerUnit: { type: "number" },
    fees: { type: "number" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
  },
  required: ["holdingId", "kind"],
  additionalProperties: false,
});

/**
 * `propose_transfer` (#1482). Three arguments, and none of them is a figure: the two
 * holdings — the one judgement no parser can make, «el fondo A» is an id — plus a
 * summary.
 *
 * The importe, the date and the participaciones are deliberately NOT here. They are
 * read off the user's own message by worthline ({@link ../typed-transfer}), so there is
 * no field for the model to fill with a figure it remembers, which is the frontier this
 * lane rests on. The two VLs are not here either: a leg that states its participaciones
 * derives its own (#1544), and one that does not is valued at the app's own price.
 */
export const TRANSFER_PROPOSAL_SCHEMA = jsonSchema<{
  originHoldingId?: string;
  destinationHoldingId?: string;
  summary?: string;
}>({
  type: "object",
  properties: {
    originHoldingId: { type: "string" },
    destinationHoldingId: { type: "string" },
    summary: { type: "string", maxLength: PROPOSAL_SUMMARY_MAX_CHARS },
  },
  required: ["originHoldingId", "destinationHoldingId"],
  additionalProperties: false,
});
