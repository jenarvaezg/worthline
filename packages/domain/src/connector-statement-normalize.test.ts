import { describe, expect, test } from "vitest";

import { reconcileFacts } from "./connector-port";
import {
  statementFactsFromStatement,
  statementRowKey,
} from "./connector-statement-normalize";
import type { Instant } from "./dates";
import type { ParsedStatement, ParsedStatementRow } from "./statement-parse";

function row(overrides: Partial<ParsedStatementRow> = {}): ParsedStatementRow {
  return {
    isin: "IE00B4L5Y983",
    dateKey: "2026-03-01",
    kind: "buy",
    units: "10",
    pricePerUnit: "100",
    feesMinor: 0,
    currency: "EUR",
    ...overrides,
  };
}

function statement(rows: ParsedStatementRow[]): ParsedStatement {
  const isins = [...new Set(rows.map((r) => r.isin).filter((i): i is string => !!i))];
  return {
    isin: isins.length === 1 ? isins[0]! : null,
    isins,
    rows,
    skipped: [],
    directionResolved: true,
  };
}

describe("statementRowKey", () => {
  test("is stable for the same underlying operation", () => {
    expect(statementRowKey(row())).toBe(statementRowKey(row()));
  });

  test("distinguishes direction, date, units, price and instrument", () => {
    const base = statementRowKey(row());
    expect(statementRowKey(row({ kind: "sell" }))).not.toBe(base);
    expect(statementRowKey(row({ dateKey: "2026-03-02" }))).not.toBe(base);
    expect(statementRowKey(row({ units: "11" }))).not.toBe(base);
    expect(statementRowKey(row({ pricePerUnit: "101" }))).not.toBe(base);
    expect(statementRowKey(row({ isin: "US0378331005" }))).not.toBe(base);
    expect(statementRowKey(row({ currency: "USD" }))).not.toBe(base);
  });

  test("falls back to name when the row carries no isin", () => {
    const a = statementRowKey(row({ isin: null, name: "Fondo A" }));
    const b = statementRowKey(row({ isin: null, name: "Fondo B" }));
    expect(a).not.toBe(b);
    expect(a).toContain("name:Fondo A");
  });

  test("two same-day, same-instrument ops separate by intraday timestamp", () => {
    const morning = statementRowKey(
      row({ occurredAt: "2026-03-01T09:00:00.000Z" as Instant }),
    );
    const afternoon = statementRowKey(
      row({ occurredAt: "2026-03-01T15:00:00.000Z" as Instant }),
    );
    expect(morning).not.toBe(afternoon);
  });
});

describe("statementFactsFromStatement", () => {
  test("maps loaded rows to facts in file order, carrying the row as payload", () => {
    const rows = [
      row({ dateKey: "2026-03-01" }),
      row({ dateKey: "2026-04-01", units: "5" }),
    ];
    const facts = statementFactsFromStatement(statement(rows));

    expect(facts.map((f) => f.dateKey)).toEqual(["2026-03-01", "2026-04-01"]);
    expect(facts[0]!.payload).toBe(rows[0]);
    expect(facts[0]!.key).toBe(statementRowKey(rows[0]!));
  });

  test("re-importing the identical file reconciles to zero new facts", () => {
    const facts = statementFactsFromStatement(
      statement([
        row({ dateKey: "2026-03-01" }),
        row({ dateKey: "2026-04-01", units: "5" }),
      ]),
    );

    // First import: everything is new.
    const first = reconcileFacts({ facts, cursor: null }, new Set());
    expect(first.toApply).toHaveLength(2);

    // Second import of the same file: the dedup ledger drops all of it.
    const seen = new Set(first.toApply.map((f) => f.key));
    const second = reconcileFacts({ facts, cursor: null }, seen);
    expect(second.toApply).toHaveLength(0);
  });

  test("an overlapping second export applies only the rows not already seen", () => {
    const shared = row({ dateKey: "2026-03-01" });
    const fresh = row({ dateKey: "2026-05-01", units: "7" });

    const firstFacts = statementFactsFromStatement(statement([shared]));
    const seen = new Set(
      reconcileFacts({ facts: firstFacts, cursor: null }, new Set()).toApply.map(
        (f) => f.key,
      ),
    );

    // A later export re-includes the shared row plus a new one.
    const secondFacts = statementFactsFromStatement(statement([shared, fresh]));
    const plan = reconcileFacts({ facts: secondFacts, cursor: null }, seen);
    expect(plan.toApply.map((f) => f.dateKey)).toEqual(["2026-05-01"]);
  });
});
