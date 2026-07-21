import { describe, expect, test } from "vitest";
import { type InboxRowAction, reconcileInbox, resolveInbox } from "./connector-inbox";
import type { NormalizedBatch, NormalizedFact } from "./connector-port";

function fact(
  key: string,
  dateKey = "2026-01-01",
  payload: unknown = { key },
): NormalizedFact {
  return { key, dateKey, payload };
}

function batch(
  facts: NormalizedFact[],
  cursor: string | null = "cursor-1",
): NormalizedBatch {
  return { facts, cursor };
}

describe("reconcileInbox — classification", () => {
  test("an unseen, unambiguous fact is new (default action: accept)", () => {
    const plan = reconcileInbox({ batch: batch([fact("a")]), seen: new Set() });

    expect(plan.rows).toEqual([
      { fact: fact("a"), disposition: "new", defaultAction: "accept" },
    ]);
    expect(plan.counts).toEqual({ new: 1, modified: 0, dubious: 0, skipped: 0 });
    expect(plan.cursor).toBe("cursor-1");
  });

  test("a fact already applied by a prior sync is skipped as a duplicate", () => {
    const plan = reconcileInbox({
      batch: batch([fact("a"), fact("b")]),
      seen: new Set(["a"]),
    });

    expect(plan.rows.map((r) => [r.disposition, r.reason])).toEqual([
      ["skipped", "duplicate"],
      ["new", undefined],
    ]);
    expect(plan.counts.skipped).toBe(1);
    expect(plan.counts.new).toBe(1);
  });

  test("a permanently rejected key is skipped and never resurfaces as new", () => {
    const plan = reconcileInbox({
      batch: batch([fact("a"), fact("b")]),
      seen: new Set(),
      rejected: new Set(["a"]),
    });

    expect(plan.rows[0]).toEqual({
      fact: fact("a"),
      disposition: "skipped",
      reason: "rejected",
      defaultAction: "ignore_once",
    });
    expect(plan.rows[1]!.disposition).toBe("new");
  });

  test("rejection wins over a would-be duplicate classification", () => {
    const plan = reconcileInbox({
      batch: batch([fact("a")]),
      seen: new Set(["a"]),
      rejected: new Set(["a"]),
    });
    expect(plan.rows[0]!.reason).toBe("rejected");
  });

  test("a within-batch repeat of a key is skipped as a duplicate (overlapping page)", () => {
    const plan = reconcileInbox({
      batch: batch([fact("a"), fact("a"), fact("c")]),
      seen: new Set(),
    });

    expect(plan.rows.map((r) => r.disposition)).toEqual(["new", "skipped", "new"]);
    expect(plan.rows[1]!.reason).toBe("duplicate");
  });

  test("a fact whose identity was applied under a different content key is modified", () => {
    // Same operation restated (a corrected price) → new content key, same identity.
    const plan = reconcileInbox({
      batch: batch([fact("acme|2026-01-01|buy|10|101")]),
      seen: new Set(),
      identityOf: (f) => f.key.split("|").slice(0, 3).join("|"),
      appliedIdentities: new Map([["acme|2026-01-01|buy", "acme|2026-01-01|buy|10|100"]]),
    });

    expect(plan.rows[0]!.disposition).toBe("modified");
    expect(plan.rows[0]!.supersedes).toBe("acme|2026-01-01|buy|10|100");
    // Surfaced for review, not auto-applied: the supersede/merge is deferred (#825).
    expect(plan.rows[0]!.defaultAction).toBe("ignore_once");
  });

  test("a fact whose identity maps to its own key is new, not modified", () => {
    const key = "acme|2026-01-01|buy|10|100";
    const plan = reconcileInbox({
      batch: batch([fact(key)]),
      seen: new Set(),
      identityOf: (f) => f.key.split("|").slice(0, 3).join("|"),
      appliedIdentities: new Map([["acme|2026-01-01|buy", key]]),
    });
    // Identity resolves to the same content key already applied → it would be a
    // duplicate by key, but seen is empty here so it is simply new (not modified).
    expect(plan.rows[0]!.disposition).toBe("new");
  });

  test("an ambiguous fact is dubious (default action: ignore-once), even if it also matches an identity", () => {
    const plan = reconcileInbox({
      batch: batch([fact("x")]),
      seen: new Set(),
      isDubious: () => true,
      identityOf: () => "id",
      appliedIdentities: new Map([["id", "other-key"]]),
    });

    expect(plan.rows[0]!.disposition).toBe("dubious");
    expect(plan.rows[0]!.defaultAction).toBe("ignore_once");
  });

  test("does not mutate the caller's seen set", () => {
    const seen = new Set(["a"]);
    reconcileInbox({ batch: batch([fact("b")]), seen });
    expect([...seen]).toEqual(["a"]);
  });
});

describe("resolveInbox — row actions → decision", () => {
  const plan = () =>
    reconcileInbox({
      batch: batch([fact("a"), fact("b"), fact("c")]),
      seen: new Set(),
    });

  test("defaults apply every new fact (accept) and reject nothing", () => {
    const decision = resolveInbox({ plan: plan() });
    expect(decision.toApply.map((f) => f.key)).toEqual(["a", "b", "c"]);
    expect(decision.toReject).toEqual([]);
    expect(decision.cursor).toBe("cursor-1");
  });

  test("ignore-once drops a fact from the batch without remembering it", () => {
    const actions = new Map<string, InboxRowAction>([["b", "ignore_once"]]);
    const decision = resolveInbox({ plan: plan(), actions });
    expect(decision.toApply.map((f) => f.key)).toEqual(["a", "c"]);
    expect(decision.toReject).toEqual([]);
  });

  test("ignore-always drops a fact AND records its key for the discard ledger", () => {
    const actions = new Map<string, InboxRowAction>([["b", "ignore_always"]]);
    const decision = resolveInbox({ plan: plan(), actions });
    expect(decision.toApply.map((f) => f.key)).toEqual(["a", "c"]);
    expect(decision.toReject).toEqual(["b"]);
  });

  test("edit applies the caller's replacement fact instead of the original", () => {
    const replacement = fact("a-corrected", "2026-02-02", { fixed: true });
    const actions = new Map<string, InboxRowAction>([["a", "edit"]]);
    const edits = new Map([["a", replacement]]);
    const decision = resolveInbox({ plan: plan(), actions, edits });
    expect(decision.toApply.map((f) => f.key)).toEqual(["a-corrected", "b", "c"]);
  });

  test("an edit action without a replacement throws (a caller bug, not silent data loss)", () => {
    const actions = new Map<string, InboxRowAction>([["a", "edit"]]);
    expect(() => resolveInbox({ plan: plan(), actions })).toThrow(/replacement/);
  });

  test("a within-batch duplicate is decided once — the accepted key is never applied twice", () => {
    const dupPlan = reconcileInbox({
      batch: batch([fact("a"), fact("a")]),
      seen: new Set(),
    });
    // Even forcing 'accept' on the duplicated key applies it exactly once.
    const actions = new Map<string, InboxRowAction>([["a", "accept"]]);
    const decision = resolveInbox({ plan: dupPlan, actions });
    expect(decision.toApply.map((f) => f.key)).toEqual(["a"]);
  });

  test("skipped rows are inert by default (no apply, no reject)", () => {
    const skipPlan = reconcileInbox({
      batch: batch([fact("a")]),
      seen: new Set(["a"]),
    });
    const decision = resolveInbox({ plan: skipPlan });
    expect(decision.toApply).toEqual([]);
    expect(decision.toReject).toEqual([]);
  });
});
