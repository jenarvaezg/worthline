import type {
  CreateInvestmentOperationInput,
  DomainResult,
  ParsedStatementRow,
} from "@worthline/domain";
import {
  BASE_CURRENCY,
  convertCapturedFigures,
  convertOperationToBaseCurrency,
} from "@worthline/domain";
import type { ResolveFxRateSnapshotOptions } from "./fx-rates";
import { resolveFxRateSnapshotForDates } from "./fx-rates";

/**
 * The ONE door a captured operation goes through before it is persisted (#1401).
 *
 * Every capture path — the operations form, the statement importer, the assistant's
 * two proposal writers — used to stamp `currency: "EUR"` and store whatever number it
 * was handed. This pairs the pure conversion (`convertOperationToBaseCurrency`) with
 * the ECB fetch it needs, so no call site assembles that pair itself and every one of
 * them converts at the rate of the EXECUTION date.
 *
 * All-or-nothing: one unconvertible row refuses the whole batch. A statement import
 * that wrote 12 of 14 operations and silently dropped two would leave a position
 * whose cost basis is wrong in a way nothing can tell apart from a genuine partial
 * sale — the same reasoning as the reconcile write being todo-o-nada (#1082).
 */
export interface ConvertCapturedOperationsOptions extends ResolveFxRateSnapshotOptions {}

export async function convertCapturedOperations(
  inputs: readonly CreateInvestmentOperationInput[],
  options: ConvertCapturedOperationsOptions = {},
): Promise<DomainResult<CreateInvestmentOperationInput[]>> {
  const foreign = inputs.filter((input) => input.currency !== BASE_CURRENCY);

  // No non-EUR apunte: nothing to fetch, nothing to convert. This is the ordinary
  // path, and it must cost exactly what it cost before #1401 — zero requests.
  if (foreign.length === 0) {
    return { ok: true, value: [...inputs] };
  }

  const rates = await resolveFxRateSnapshotForDates(
    foreign.map((input) => input.currency),
    foreign.map((input) => input.executedAt),
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
  const result = await convertCapturedOperations([input], options);
  if (!result.ok) {
    return result;
  }

  const [converted] = result.value;
  // `convertCapturedOperations` returns one output per input, so this cannot be
  // absent; the check is what makes that a type, not a comment.
  return converted === undefined
    ? {
        ok: false,
        violations: [
          {
            code: "operation_currency_missing_rate",
            currency: input.currency,
            executedAt: input.executedAt,
          },
        ],
      }
    : { ok: true, value: converted };
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
  const foreign = rows.filter((row) => row.currency !== BASE_CURRENCY);

  if (foreign.length === 0) {
    return { ok: true, value: [...rows] };
  }

  const rates = await resolveFxRateSnapshotForDates(
    foreign.map((row) => row.currency),
    foreign.map((row) => row.dateKey),
    options,
  );

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
