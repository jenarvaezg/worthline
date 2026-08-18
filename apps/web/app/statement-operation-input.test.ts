import type { ParsedStatementRow } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  statementRowToCreateInput,
  statementRowToOverwrite,
} from "./statement-operation-input";

const euroRow: ParsedStatementRow = {
  currency: "EUR",
  dateKey: "2026-01-23",
  feesMinor: 0,
  isin: "IE00BYX5NX33",
  kind: "buy",
  pricePerUnit: "13.84",
  units: "7.226",
};

/** The same row after `convertStatementRows`: euros, plus what the file said. */
const convertedRow: ParsedStatementRow = {
  ...euroRow,
  capture: { currency: "USD", eurPerUnit: 0.85, feesMinor: 0, pricePerUnit: "8.00" },
  pricePerUnit: "6.8",
};

describe("statementRowToCreateInput", () => {
  test("carries the capture to the ledger", () => {
    const input = statementRowToCreateInput({
      assetId: "fund",
      id: "op_1",
      row: convertedRow,
      source: "statement",
    });

    expect(input.capture).toEqual(convertedRow.capture);
    expect(input.currency).toBe("EUR");
    expect(input.executedAt).toBe("2026-01-23");
  });

  test("leaves the field absent for a euro row", () => {
    const input = statementRowToCreateInput({
      assetId: "fund",
      id: "op_1",
      row: euroRow,
      source: "agent",
    });

    expect("capture" in input).toBe(false);
    expect(input.source).toBe("agent");
  });
});

describe("statementRowToOverwrite", () => {
  test("replaces the capture", () => {
    const overwrite = statementRowToOverwrite({
      operationId: "op_1",
      row: convertedRow,
      source: "statement",
    });

    expect(overwrite.capture).toEqual(convertedRow.capture);
    expect(overwrite.id).toBe("op_1");
  });

  test("CLEARS a capture when the row is euros now", () => {
    // The store writes four NULLs for an absent capture, so a re-import that no longer
    // states dollars stops claiming them.
    const overwrite = statementRowToOverwrite({
      operationId: "op_1",
      row: euroRow,
      source: "statement",
    });

    expect(overwrite.capture).toBeUndefined();
  });
});
