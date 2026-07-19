/**
 * The common connector conformance suite (#888) runs green against the in-memory
 * reference adapter — the acceptance proof for PRD #1000 S2. A real adapter
 * (universal statement, IBKR, …) earns the same guarantees by calling
 * `describeConnectorConformance` with its own fake.
 */

import { createReferenceAdapter, reconcileFacts } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import { commitReconciled } from "./connector-commit";
import {
  createInMemoryConnectorHost,
  describeConnectorConformance,
} from "./connector-conformance";

describeConnectorConformance("reference adapter", (events) =>
  createReferenceAdapter({ events }),
);

// The host gates on declared capabilities: a fetch the connector never
// advertised is refused before any I/O, so the ADR's "capabilities are explicit"
// guarantee is enforced, not just documented.
describe("connector capability gating", () => {
  test("refuses a fetch capability the adapter did not declare", async () => {
    const host = createInMemoryConnectorHost();
    const { adapter } = createReferenceAdapter({
      events: [{ key: "p", dateKey: "2026-01-01", label: "P" }],
      capabilities: [{ kind: "fetch_positions" }],
    });

    await expect(host.runSync(adapter, "fetch_transactions")).rejects.toThrow(
      /does not support capability "fetch_transactions"/,
    );
    expect(host.appliedKeys()).toEqual([]);
    expect(host.batchCount()).toBe(0);

    // The declared capability still works.
    const ok = await host.runSync(adapter, "fetch_positions");
    expect(ok.ok && ok.value.applied).toBe(1);
  });
});

// A future-only fact must persist yet not ripple (parity with the batch executor).
describe("connector commit — future-dated facts", () => {
  test("applies a future fact but skips the ripple", async () => {
    const host = createInMemoryConnectorHost();
    const { adapter } = createReferenceAdapter({
      events: [{ key: "future", dateKey: "2099-01-01", label: "F" }],
    });

    const result = await host.runSync(adapter, "fetch_balances");
    expect(result.ok && result.value.applied).toBe(1);
    expect(host.rippleFloors()).toEqual([]);
    expect(host.batchCount()).toBe(1);
  });
});

// The commit's own contract, independent of any adapter.
describe("commitReconciled", () => {
  test("carries the cursor forward on an all-duplicate plan without persisting", async () => {
    const plan = reconcileFacts(
      { facts: [{ key: "a", dateKey: "2026-01-01", payload: null }], cursor: "c9" },
      new Set(["a"]),
    );

    const persisted: string[] = [];
    let recorded: { cursor: string | null; applied: number } | null = null;
    const result = await commitReconciled({
      plan,
      today: "2026-07-19",
      connectedSourceId: "src-1",
      persistFact: async (fact) => {
        persisted.push(fact.key);
      },
      ripple: async () => {},
      recordCommit: async ({ cursor, appliedKeys }) => {
        recorded = { cursor, applied: appliedKeys.length };
      },
      uow: {
        createFactBatch: async () => "batch-1",
        transaction: (work) => Promise.resolve(work()),
      },
    });

    expect(result.ok && result.value).toEqual({
      applied: 0,
      cursor: "c9",
      ripple: null,
    });
    expect(persisted).toEqual([]);
    expect(recorded).toEqual({ cursor: "c9", applied: 0 });
  });
});
