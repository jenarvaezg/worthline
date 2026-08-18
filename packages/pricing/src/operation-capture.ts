import type {
  CreateInvestmentOperationInput,
  DomainResult,
  FxRateSnapshot,
  ParsedStatementRow,
} from "@worthline/domain";
import {
  BASE_CURRENCY,
  convertCapturedFigures,
  convertOperationToBaseCurrency,
  createFxRateSnapshot,
} from "@worthline/domain";
import type { ResolveFxRateSnapshotOptions } from "./fx-rates";
import { resolveFxRateSnapshotForDates } from "./fx-rates";

/**
 * The ONE door a captured operation goes through before it is persisted (#1401).
 *
 * Every capture path — the operations form, the statement importer, the assistant's
 * statement proposal — used to stamp `currency: "EUR"` and store whatever number it was
 * handed. This pairs the pure conversion (`convertOperationToBaseCurrency`) with
 * the ECB fetch it needs, so no call site assembles that pair itself and every one of
 * them converts at the rate of the EXECUTION date.
 *
 * All-or-nothing: one unconvertible row refuses the whole batch. A statement import
 * that wrote 12 of 14 operations and silently dropped two would leave a position
 * whose cost basis is wrong in a way nothing can tell apart from a genuine partial
 * sale — the same reasoning as the reconcile write being todo-o-nada (#1082).
 */

/**
 * What the capture door can be given: today, only the ECB fetcher a test injects. Named
 * after this door rather than reusing `ResolveFxRateSnapshotOptions` because every call
 * site names the type, and they are converting a capture, not resolving a snapshot.
 */
export type ConvertCapturedOperationsOptions = ResolveFxRateSnapshotOptions;

export async function convertCapturedOperations(
  inputs: readonly CreateInvestmentOperationInput[],
  options: ConvertCapturedOperationsOptions = {},
): Promise<DomainResult<CreateInvestmentOperationInput[]>> {
  const rates = await ratesForCaptures(
    inputs.map((input) => ({ currency: input.currency, dateKey: input.executedAt })),
    options,
  );

  const converted: CreateInvestmentOperationInput[] = [];
  for (const input of inputs) {
    const result = convertOperationToBaseCurrency(input, rates);
    if (!result.ok) {
      return result;
    }
    converted.push(result.value);
  }

  return { ok: true, value: converted };
}

/** Single-operation {@link convertCapturedOperations}, for the one-apunte form. */
export async function convertCapturedOperation(
  input: CreateInvestmentOperationInput,
  options: ConvertCapturedOperationsOptions = {},
): Promise<DomainResult<CreateInvestmentOperationInput>> {
  const rates = await ratesForCaptures(
    [{ currency: input.currency, dateKey: input.executedAt }],
    options,
  );

  return convertOperationToBaseCurrency(input, rates);
}

/**
 * The ECB observations a set of captures needs: ONE request per non-EUR currency over a
 * window covering every date. An all-EUR set fetches nothing and gets an empty snapshot
 * — which is all a EUR conversion needs, since it never looks a rate up. That is what
 * keeps the ordinary path costing exactly what it cost before #1401.
 */
function ratesForCaptures(
  captures: readonly { currency: string; dateKey: string }[],
  options: ConvertCapturedOperationsOptions,
): Promise<FxRateSnapshot> {
  const foreign = captures.filter((capture) => capture.currency !== BASE_CURRENCY);

  if (foreign.length === 0) {
    return Promise.resolve(createFxRateSnapshot({}));
  }

  return resolveFxRateSnapshotForDates(
    foreign.map((capture) => capture.currency),
    foreign.map((capture) => capture.dateKey),
    options,
  );
}

/**
 * Convert a whole statement's rows to euros, each at the rate of ITS date (#1401).
 *
 * Done to the ROWS, right after the parse, rather than to the operations at the end:
 * the merge plan compares incoming rows against stored operations by units and price,
 * and stored operations are euros. Converting first is what makes that comparison
 * meaningful — and it means the preview shows the same figures the confirm writes,
 * the lesson of #1438.
 *
 * A row keeps its `capture`, so the operation built from it carries the original
 * apunte all the way to the ledger.
 */
export async function convertStatementRows(
  rows: readonly ParsedStatementRow[],
  options: ConvertCapturedOperationsOptions = {},
): Promise<DomainResult<ParsedStatementRow[]>> {
  const rates = await ratesForCaptures(rows, options);

  const converted: ParsedStatementRow[] = [];
  for (const row of rows) {
    const result = convertCapturedFigures(
      {
        currency: row.currency,
        dateKey: row.dateKey,
        feesMinor: row.feesMinor,
        pricePerUnit: row.pricePerUnit,
      },
      rates,
    );

    if (!result.ok) {
      return result;
    }

    converted.push(
      result.value.capture === undefined
        ? row
        : {
            ...row,
            capture: result.value.capture,
            currency: BASE_CURRENCY,
            feesMinor: result.value.feesMinor,
            pricePerUnit: result.value.pricePerUnit,
          },
    );
  }

  return { ok: true, value: converted };
}
