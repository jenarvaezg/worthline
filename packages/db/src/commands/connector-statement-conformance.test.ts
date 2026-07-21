/**
 * The universal-statement adapter (PRD #1000 S3) is the FIRST real connector: it
 * earns the port's guarantees by passing the common conformance suite, exactly as
 * the reference adapter does — and an end-to-end pass drives a realistic parsed
 * statement through `normalize → reconcile → confirm` to prove the file feed
 * commits through `applyDatedFactsBatch` and re-imports idempotently.
 */

import type { ParsedStatement, ParsedStatementRow } from "@worthline/domain";
import {
  createStatementConnectorAdapter,
  statementFactsFromStatement,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  createInMemoryConnectorHost,
  describeConnectorConformance,
} from "./connector-conformance";

// The universal statement passes the same battery every connector must — proving
// a one-shot file feed satisfies the port just as the incremental reference does.
describeConnectorConformance("universal statement", (events) =>
  createStatementConnectorAdapter({
    rows: events.map((event) => ({
      key: event.key,
      dateKey: event.dateKey,
      payload: { label: event.label },
    })),
  }),
);

function statementRow(overrides: Partial<ParsedStatementRow>): ParsedStatementRow {
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

// A realistic multi-ISIN statement: two instruments, buys and a sell across dates.
const REAL_STATEMENT: ParsedStatement = {
  isin: null,
  isins: ["IE00B4L5Y983", "US0378331005"],
  rows: [
    statementRow({
      isin: "IE00B4L5Y983",
      dateKey: "2026-01-15",
      units: "12",
      pricePerUnit: "95",
    }),
    statementRow({
      isin: "IE00B4L5Y983",
      dateKey: "2026-02-15",
      units: "8",
      pricePerUnit: "101",
    }),
    statementRow({
      isin: "US0378331005",
      dateKey: "2026-02-20",
      units: "5",
      pricePerUnit: "180",
    }),
    statementRow({
      isin: "US0378331005",
      dateKey: "2026-03-10",
      kind: "sell",
      units: "2",
      pricePerUnit: "190",
    }),
  ],
  skipped: [],
  directionResolved: true,
};

describe("universal statement — end-to-end over a real file", () => {
  test("normalize → reconcile → commit applies every row once, floored at the earliest date", async () => {
    const host = createInMemoryConnectorHost();
    const facts = statementFactsFromStatement(REAL_STATEMENT);
    const { adapter } = createStatementConnectorAdapter({ rows: facts });

    const result = await host.runSync(adapter, "fetch_transactions");

    expect(result.ok && result.value.applied).toBe(4);
    expect(host.appliedFacts().map((f) => f.dateKey)).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-02-20",
      "2026-03-10",
    ]);
    // One batch, one ripple, floored at the earliest applied date (ADR 0020/0062).
    expect(host.batchCount()).toBe(1);
    expect(host.rippleFloors()).toEqual(["2026-01-15"]);
  });

  test("re-importing the identical file is an idempotent no-op that still reports freshness", async () => {
    const host = createInMemoryConnectorHost();
    const facts = statementFactsFromStatement(REAL_STATEMENT);
    const { adapter } = createStatementConnectorAdapter({ rows: facts });

    await host.runSync(adapter, "fetch_transactions");
    const reimport = await host.runSync(adapter, "fetch_transactions");

    expect(reimport.ok && reimport.value.applied).toBe(0);
    expect(host.appliedKeys()).toHaveLength(4);
    // A sync still happened: one more batch, no new facts, no extra ripple.
    expect(host.batchCount()).toBe(2);
    expect(host.rippleFloors()).toEqual(["2026-01-15"]);
  });
});
