/**
 * The v1 attachment extraction contract, as its ~55 callers already import it.
 *
 * The contract itself lives one file per DOCUMENT FAMILY (#1699), because that is the
 * partition it always had in its head and never had on disk: the shared vocabulary in
 * `attachment-extraction-primitives`, one module per family, the envelope and the
 * discriminated union that registers them in `attachment-extraction-envelope`. This
 * file is the published surface and nothing else — no schema, no rule, no bound is
 * declared here, so a new family is a new module plus its line in the union, without
 * any sibling family having to be opened.
 *
 * It re-exports EXPLICITLY rather than with `export *`: the public surface of a
 * contract 55 files depend on is a decision, and a name that is only shared between
 * family modules (`isoDateSchema`, `extractedNumberSchema`, `nonEmptyStringSchema`, …)
 * must not become public by accident.
 */

export {
  balanceSeriesDocumentSchema,
  type DatedBalance,
  datedBalanceSchema,
  type ExtractedBalanceSeriesDocument,
} from "./attachment-extraction-balance-series";
export {
  type AttachmentExtractionResult,
  type AttachmentLimitInput,
  checkAttachmentLimits,
  type ExtractedDocument,
  extractedDocumentSchema,
  INVALID_OUTPUT_FAILURE,
  parseExtractionResult,
} from "./attachment-extraction-envelope";
export {
  DECLARED_EFFECT_KINDS,
  type DeclaredEffectKind,
  type ExtractedHoldingEvent,
  type ExtractedHoldingEventDocument,
  HOLDING_EVENT_KINDS,
  type HoldingEventKind,
  holdingEventDocumentSchema,
} from "./attachment-extraction-holding-event";
export {
  type ExtractedPosition,
  type ExtractedPositionsDocument,
  extractedPositionSchema,
  positionsDocumentSchema,
} from "./attachment-extraction-positions";
export {
  type ExtractedHolding,
  type ExtractedMovement,
  type ExtractedPositionsMovementsDocument,
  extractedHoldingSchema,
  extractedMovementSchema,
  HOLDING_FIDELITY_TIERS,
  type HoldingFidelity,
  MOVEMENT_KINDS,
  type MovementKind,
  movementLinksToHolding,
  positionsMovementsDocumentSchema,
  resolveHoldingFidelity,
} from "./attachment-extraction-positions-movements";
export {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  type AttachmentLimitReason,
  capExtractionWarnings,
  currencySchema,
  type ExtractorFailureCode,
  type ExtractorFailureKind,
  isIsoDay,
  isValidIsin,
  normalizeExtractedNumber,
  type UnrecognizedReason,
} from "./attachment-extraction-primitives";
export {
  brokerTransactionsDocumentSchema,
  type ExtractedBrokerTransactionsDocument,
  type ExtractedTransaction,
  extractedTransactionSchema,
  TRANSACTION_KINDS,
  type TransactionKind,
} from "./attachment-extraction-transactions";
