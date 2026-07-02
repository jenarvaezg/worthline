import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import { planStatementMerge } from "./statement-merge";
import type { ParsedStatementRow } from "./statement-parse";

/**
 * Merge-by-date planner (ADR 0018, S2 / #175). The file is authoritative for the
 * dates it covers, never for the whole asset: a file date matching an existing
 * operation overwrites it, a new date creates, and an existing operation the file
 * does not mention is left untouched. Match key = date alone.
 */

function buy(dateKey: string, units = "10", pricePerUnit = "100"): ParsedStatementRow {
  return {
    currency: "EUR",
    dateKey,
    feesMinor: 0,
    isin: "IE00TEST0001",
    kind: "buy",
    pricePerUnit: pricePerUnit as ParsedStatementRow["pricePerUnit"],
    units: units as ParsedStatementRow["units"],
  };
}

function op(
  id: string,
  executedAt: string,
  units = "1",
  price = "50",
): InvestmentOperation {
  return {
    assetId: "fund",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: price as InvestmentOperation["pricePerUnit"],
    units: units as InvestmentOperation["units"],
  };
}

describe("planStatementMerge (ADR 0018, S2)", () => {
  test("worked example: 1-Mar matches, nine new dates, 1-Apr untouched", () => {
    // Asset has operations on 1-Mar and 1-Apr.
    const existing = [op("op_mar", "2024-03-01"), op("op_apr", "2024-04-01")];
    // File covers 1-Mar plus nine OTHER dates (no 1-Apr).
    const rows = [
      buy("2024-03-01"),
      buy("2024-05-01"),
      buy("2024-06-01"),
      buy("2024-07-01"),
      buy("2024-08-01"),
      buy("2024-09-01"),
      buy("2024-10-01"),
      buy("2024-11-01"),
      buy("2024-12-01"),
      buy("2025-01-01"),
    ];

    const plan = planStatementMerge(rows, existing);

    expect(plan.toCreate).toHaveLength(9);
    expect(plan.toOverwrite).toHaveLength(1);
    expect(plan.toOverwrite[0]!.operationId).toBe("op_mar");
    expect(plan.toOverwrite[0]!.row.dateKey).toBe("2024-03-01");
    // 1-Apr is absent from the file → left untouched, never deleted.
    expect(plan.untouched.map((o) => o.id)).toEqual(["op_apr"]);
    expect(plan.toCreate.map((r) => r.dateKey)).not.toContain("2024-03-01");
  });

  test("empty asset: every file row is a create, nothing to overwrite", () => {
    const rows = [buy("2024-03-01"), buy("2024-04-01")];

    const plan = planStatementMerge(rows, []);

    expect(plan.toCreate).toHaveLength(2);
    expect(plan.toOverwrite).toHaveLength(0);
    expect(plan.untouched).toHaveLength(0);
  });

  test("overwrite carries the file's units/price/kind for the matched date", () => {
    const existing = [op("op_mar", "2024-03-01", "1", "50")];
    const rows = [buy("2024-03-01", "7.226", "13.84")];

    const plan = planStatementMerge(rows, existing);

    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toOverwrite).toHaveLength(1);
    expect(plan.toOverwrite[0]!.row.units).toBe("7.226");
    expect(plan.toOverwrite[0]!.row.pricePerUnit).toBe("13.84");
    expect(plan.untouched).toHaveLength(0);
  });

  test("idempotent re-plan: same dates overwrite their match, create nothing", () => {
    // Existing operations on exactly the file's dates (a prior load).
    const existing = [op("op_a", "2024-03-01"), op("op_b", "2024-04-01")];
    const rows = [buy("2024-03-01"), buy("2024-04-01")];

    const plan = planStatementMerge(rows, existing);

    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toOverwrite.map((o) => o.operationId).sort()).toEqual(["op_a", "op_b"]);
    expect(plan.untouched).toHaveLength(0);
  });

  test("date match ignores any time component on the existing operation", () => {
    const existing = [op("op_mar", "2024-03-01T09:30:00.000Z")];
    const rows = [buy("2024-03-01")];

    const plan = planStatementMerge(rows, existing);

    expect(plan.toOverwrite).toHaveLength(1);
    expect(plan.toOverwrite[0]!.operationId).toBe("op_mar");
    expect(plan.toCreate).toHaveLength(0);
  });

  test("unambiguous merges carry no anomalies", () => {
    const plan = planStatementMerge([buy("2024-03-01")], [op("op_apr", "2024-04-01")]);
    expect(plan.anomalies).toEqual([]);
  });
});

describe("planStatementMerge — same-date anomalies (ADR 0018, S4)", () => {
  test("a date repeated within the file is flagged, neither created nor overwritten", () => {
    const rows = [buy("2024-03-01", "5"), buy("2024-03-01", "6"), buy("2024-04-01")];

    const plan = planStatementMerge(rows, []);

    // 2024-03-01 is ambiguous in the file → flagged, not created. 2024-04-01 is fine.
    expect(plan.anomalies).toEqual([
      { dateKey: "2024-03-01", reason: "duplicate-in-file" },
    ]);
    expect(plan.toCreate.map((r) => r.dateKey)).toEqual(["2024-04-01"]);
    expect(plan.toOverwrite).toHaveLength(0);
  });

  test("a date the asset already carries twice is flagged; its operations stay untouched", () => {
    // The asset somehow has two operations on the same date — we can't tell which
    // the file row should overwrite, so we touch neither.
    const existing = [
      op("op_a", "2024-03-01"),
      op("op_b", "2024-03-01"),
      op("op_c", "2024-05-01"),
    ];
    const rows = [buy("2024-03-01"), buy("2024-06-01")];

    const plan = planStatementMerge(rows, existing);

    expect(plan.anomalies).toEqual([
      { dateKey: "2024-03-01", reason: "duplicate-on-asset" },
    ]);
    // The 2024-03-01 file row is NOT overwritten (ambiguous); 2024-06-01 creates.
    expect(plan.toOverwrite).toHaveLength(0);
    expect(plan.toCreate.map((r) => r.dateKey)).toEqual(["2024-06-01"]);
    // Both duplicate ops and the unrelated op survive untouched, none deleted.
    expect(plan.untouched.map((o) => o.id).sort()).toEqual(["op_a", "op_b", "op_c"]);
  });
});
