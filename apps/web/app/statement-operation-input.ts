import type { UpdateInvestmentOperationInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  OperationSource,
  ParsedStatementRow,
} from "@worthline/domain";

/**
 * A statement row → the operation command that persists it.
 *
 * There are THREE statement doors — the whole-portfolio importer, the per-holding
 * upload, and the assistant's proposal — and each of them writes creates AND
 * overwrites, so this shape existed six times. #1401 had to add the same
 * `capture` line to all six, which is exactly the Shotgun Surgery that says the
 * shape wants one home: the next field a row carries gets added once.
 *
 * `source` is the only thing that differs between the doors (`statement` vs `agent`),
 * so it is the only parameter. Pure — no store, no IO.
 *
 * The row is expected ALREADY CONVERTED to EUR (`convertStatementRows`); `capture` is
 * what the file stated, and it travels to the ledger so the operation can be read back
 * in the currency the bank used.
 */
export function statementRowToCreateInput({
  assetId,
  id,
  row,
  source,
}: {
  assetId: string;
  id: string;
  row: ParsedStatementRow;
  source: OperationSource;
}): CreateInvestmentOperationInput {
  return {
    assetId,
    ...(row.capture === undefined ? {} : { capture: row.capture }),
    currency: row.currency,
    executedAt: row.dateKey,
    feesMinor: row.feesMinor,
    id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source,
    units: row.units,
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
  };
}

/**
 * A statement row → the overwrite of an operation already on that date.
 *
 * The capture is passed even when absent (as `undefined`), because an overwrite
 * REPLACES it: a re-imported file that now states euros must clear the dollars the
 * previous import wrote, or the ficha keeps showing an original that no longer backs
 * the stored figure (#1401).
 */
export function statementRowToOverwrite({
  operationId,
  row,
  source,
}: {
  operationId: string;
  row: ParsedStatementRow;
  source: OperationSource;
}): UpdateInvestmentOperationInput {
  return {
    ...(row.capture === undefined ? {} : { capture: row.capture }),
    currency: row.currency,
    feesMinor: row.feesMinor,
    id: operationId,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source,
    units: row.units,
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
  };
}
