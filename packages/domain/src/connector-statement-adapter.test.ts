import { describe, expect, test } from "vitest";

import type { NormalizedFact } from "./connector-port";
import {
  createStatementConnectorAdapter,
  statementContentToken,
} from "./connector-statement-adapter";

const ROWS: NormalizedFact<{ label: string }>[] = [
  { key: "a", dateKey: "2026-03-01", payload: { label: "A" } },
  { key: "b", dateKey: "2026-04-01", payload: { label: "B" } },
];

describe("statementContentToken", () => {
  test("is deterministic and order-sensitive", () => {
    expect(statementContentToken(ROWS)).toBe(statementContentToken(ROWS));
    expect(statementContentToken(ROWS)).not.toBe(
      statementContentToken([...ROWS].reverse()),
    );
  });

  test("differs when a row's key or date changes", () => {
    const token = statementContentToken(ROWS);
    expect(statementContentToken([{ ...ROWS[0]!, key: "z" }, ROWS[1]!])).not.toBe(token);
    expect(
      statementContentToken([{ ...ROWS[0]!, dateKey: "2026-03-02" }, ROWS[1]!]),
    ).not.toBe(token);
  });

  test("an empty file has a stable token", () => {
    expect(statementContentToken([])).toBe(statementContentToken([]));
  });
});

describe("createStatementConnectorAdapter", () => {
  test("declares fetch_transactions + disconnect by default and its id", () => {
    const { adapter } = createStatementConnectorAdapter({ rows: ROWS });
    expect(adapter.id).toBe("universal-statement");
    expect(adapter.capabilities.map((c) => c.kind).sort()).toEqual([
      "disconnect",
      "fetch_transactions",
    ]);
  });

  test("a fresh import serves every row once with the content token as cursor", async () => {
    const { adapter } = createStatementConnectorAdapter({ rows: ROWS });
    const batch = await adapter.fetch({ capability: "fetch_transactions", cursor: null });

    expect(batch.facts.map((f) => f.key)).toEqual(["a", "b"]);
    expect(batch.cursor).toBe(statementContentToken(ROWS));
    // Pure: the emitted facts are copies, not the caller's row objects.
    expect(batch.facts[0]).not.toBe(ROWS[0]);
  });

  test("re-fetching from this file's own token is a no-op freshness signal", async () => {
    const { adapter } = createStatementConnectorAdapter({ rows: ROWS });
    const token = statementContentToken(ROWS);

    const noop = await adapter.fetch({ capability: "fetch_transactions", cursor: token });
    expect(noop.facts).toEqual([]);
    expect(noop.cursor).toBe(token);
  });

  test("re-fetching from a stale/other cursor re-serves rows for dedup", async () => {
    const { adapter } = createStatementConnectorAdapter({ rows: ROWS });
    const replay = await adapter.fetch({
      capability: "fetch_transactions",
      cursor: "some-other-file-token",
    });
    expect(replay.facts.map((f) => f.key)).toEqual(["a", "b"]);
  });

  test("preserves duplicate keys within a file so the port can dedup them", async () => {
    const dupes: NormalizedFact<{ label: string }>[] = [
      { key: "a", dateKey: "2026-03-01", payload: { label: "A" } },
      { key: "a", dateKey: "2026-03-01", payload: { label: "A again" } },
    ];
    const { adapter } = createStatementConnectorAdapter({ rows: dupes });
    const batch = await adapter.fetch({ capability: "fetch_transactions", cursor: null });
    expect(batch.facts.map((f) => f.key)).toEqual(["a", "a"]);
  });

  test("failNextFetch rejects exactly one fetch, then recovers", async () => {
    const handle = createStatementConnectorAdapter({ rows: ROWS });
    handle.failNextFetch();
    await expect(
      handle.adapter.fetch({ capability: "fetch_transactions", cursor: null }),
    ).rejects.toThrow(/statement read failure/);
    const recovered = await handle.adapter.fetch({
      capability: "fetch_transactions",
      cursor: null,
    });
    expect(recovered.facts.map((f) => f.key)).toEqual(["a", "b"]);
    expect(handle.fetchCount()).toBe(2);
  });

  test("disconnect flips the observable handle", async () => {
    const handle = createStatementConnectorAdapter({ rows: ROWS });
    expect(handle.isDisconnected()).toBe(false);
    await handle.adapter.disconnect?.();
    expect(handle.isDisconnected()).toBe(true);
  });
});
