/**
 * The universal-statement adapter (PRD #1000 S3) is the FIRST real connector: it
 * earns the port's guarantees by passing the common conformance suite, exactly as
 * the reference adapter does — and an end-to-end pass drives a realistic parsed
 * statement through `normalize → reconcile → confirm` to prove the file feed
 * commits through `applyDatedFactsBatch` and re-imports idempotently.
 */

import type {
  InboxPlan,
  ParsedStatement,
  ParsedStatementRow,
  StatementFactPayload,
} from "@worthline/domain";
import {
  createStatementConnectorAdapter,
  isStatementFactDubious,
  statementFactIdentity,
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

// PRD #1000 S4 (#1068): the reconciliation inbox — the SAME universal statement
// feed, but driven through preview → reconcile (four dispositions, per-row
// actions) → confirm, proving the discard ledger persists.
describe("universal statement — reconciliation inbox (S4, #1068)", () => {
  const INBOX_STATEMENT: ParsedStatement = {
    isin: null,
    isins: ["IE00B4L5Y983", "US0378331005"],
    rows: [
      statementRow({ dateKey: "2026-01-15", units: "12", pricePerUnit: "95" }),
      statementRow({
        isin: "US0378331005",
        dateKey: "2026-02-20",
        units: "5",
        pricePerUnit: "180",
      }),
      // A name-only row (no ISIN): parseable but not confidently matchable → dubious.
      statementRow({
        isin: null,
        name: "Fondo local sin ISIN",
        dateKey: "2026-03-01",
        units: "3",
        pricePerUnit: "50",
      }),
    ],
    skipped: [],
    directionResolved: true,
  };

  const inboxOptions = {
    identityOf: statementFactIdentity,
    isDubious: isStatementFactDubious,
  } as const;

  test("classifies buckets, applies accepted rows, and ignore-always suppresses a fact on later reconciliations", async () => {
    const host = createInMemoryConnectorHost();
    const facts = statementFactsFromStatement(INBOX_STATEMENT);
    const rowA = facts[0]!;
    const rowB = facts[1]!;
    const { adapter } = createStatementConnectorAdapter({ rows: facts });

    let preview: InboxPlan<StatementFactPayload> | undefined;
    const first = await host.runInboxSync(adapter, "fetch_transactions", {
      ...inboxOptions,
      actions: new Map([[rowB.key, "ignore_always"]]),
      onPlan: (plan) => {
        preview = plan;
      },
    });

    // Preview before applying: two clean new rows + one name-only dubious row.
    expect(preview?.counts).toEqual({ new: 2, modified: 0, dubious: 1, skipped: 0 });

    // Confirm: rowA applied (default accept), rowB dismissed forever, dubious left
    // for review (default ignore-once — applied nothing, remembered nothing).
    expect(first.ok && first.value.applied).toBe(1);
    expect(first.ok && first.value.rejected).toBe(1);
    expect(host.appliedKeys()).toEqual([rowA.key]);
    expect(host.rejectedKeys()).toEqual([rowB.key]);

    // A re-served file (cursor rewound): the dismissed row is skipped as `rejected`
    // — never a `new` again — and the applied one is a `duplicate`.
    let replayPreview: InboxPlan<StatementFactPayload> | undefined;
    const replay = await host.runInboxSync(adapter, "fetch_transactions", {
      ...inboxOptions,
      cursor: null,
      onPlan: (plan) => {
        replayPreview = plan;
      },
    });

    const byKey = new Map(replayPreview!.rows.map((row) => [row.fact.key, row]));
    expect(byKey.get(rowB.key)?.disposition).toBe("skipped");
    expect(byKey.get(rowB.key)?.reason).toBe("rejected");
    expect(byKey.get(rowA.key)?.disposition).toBe("skipped");
    expect(byKey.get(rowA.key)?.reason).toBe("duplicate");
    // Nothing re-applied; the applied ledger is unchanged.
    expect(replay.ok && replay.value.applied).toBe(0);
    expect(host.appliedKeys()).toEqual([rowA.key]);
  });

  test("a restated operation (corrected price) is classified as modified, not a second new fact", async () => {
    const host = createInMemoryConnectorHost();
    const original: ParsedStatement = {
      isin: null,
      isins: ["IE00B4L5Y983"],
      rows: [statementRow({ dateKey: "2026-01-15", units: "12", pricePerUnit: "95" })],
      skipped: [],
      directionResolved: true,
    };
    const originalFacts = statementFactsFromStatement(original);
    const { adapter: first } = createStatementConnectorAdapter({ rows: originalFacts });
    await host.runInboxSync(first, "fetch_transactions", inboxOptions);
    expect(host.appliedKeys()).toEqual([originalFacts[0]!.key]);

    // The broker re-issues the statement with the same operation at a corrected
    // price: same instrument·date·direction (identity), different content key.
    const corrected: ParsedStatement = {
      ...original,
      rows: [statementRow({ dateKey: "2026-01-15", units: "12", pricePerUnit: "97" })],
    };
    const correctedFacts = statementFactsFromStatement(corrected);
    const { adapter: reissue } = createStatementConnectorAdapter({
      rows: correctedFacts,
    });

    let plan: InboxPlan<StatementFactPayload> | undefined;
    await host.runInboxSync(reissue, "fetch_transactions", {
      ...inboxOptions,
      cursor: null,
      // Leave it for review — assert the classification, not the merge (deferred).
      actions: new Map([[correctedFacts[0]!.key, "ignore_once"]]),
      onPlan: (observed) => {
        plan = observed;
      },
    });

    const modified = plan?.rows[0];
    expect(modified?.disposition).toBe("modified");
    expect(modified?.supersedes).toBe(originalFacts[0]!.key);
  });
});
