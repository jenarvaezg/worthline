import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  applyOperationMutations,
  type OperationMutation,
  parseOperationDraft,
  planOperationSubmit,
  type SubmissionKeyRef,
  submitOperationRecord,
} from "./optimistic-operations";

/**
 * The pure optimistic-merge for the investment operations editor (#521, S5 of
 * #485, interaction-patterns §4/§7). Recording an operation redirects back to the
 * same /patrimonio/[id]/editar page, so the new row can show in the list BEFORE
 * the action resolves; a delete can vanish its row the same way. Only the
 * operation ROW is faked (it is exactly what the user typed) — the derived
 * units/value/PnL in the context header are server-computed and NOT predictable,
 * so they are left to settle on the redirect (§4). Pure (no React) so the merge
 * unit-tests in the node env while the editor stays a thin `useOptimistic` shell.
 */

function op(id: string, executedAt: string): InvestmentOperation {
  return {
    id,
    assetId: "asset-1",
    kind: "buy",
    executedAt,
    units: "10" as InvestmentOperation["units"],
    pricePerUnit: "100" as InvestmentOperation["pricePerUnit"],
    currency: "EUR",
    feesMinor: 0,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    fd.set(key, value);
  }
  return fd;
}

describe("applyOperationMutations · add", () => {
  test("includes the new operation in the list", () => {
    const base = [op("o1", "2026-01-01")];

    const next = applyOperationMutations(base, [
      { kind: "add", operation: op("o2", "2026-02-01") },
    ]);

    expect(next.map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  test("never mutates the base list", () => {
    const base = [op("o1", "2026-01-01")];

    applyOperationMutations(base, [{ kind: "add", operation: op("o2", "2026-02-01") }]);

    expect(base).toHaveLength(1);
  });
});

describe("applyOperationMutations · delete", () => {
  test("removes the operation with the given id", () => {
    const base = [op("o1", "2026-01-01"), op("o2", "2026-02-01")];

    const next = applyOperationMutations(base, [{ kind: "delete", id: "o1" }]);

    expect(next.map((o) => o.id)).toEqual(["o2"]);
  });
});

describe("parseOperationDraft", () => {
  test("builds the optimistic row from the record form", () => {
    const draft = parseOperationDraft(
      form({
        kind: "sell",
        executedAt: "2026-03-15",
        units: "5",
        pricePerUnit: "200,50",
        fees: "1,20",
      }),
      "asset-1",
      "2026-06-24",
      "optimistic-1",
    );

    expect(draft).toEqual({
      id: "optimistic-1",
      assetId: "asset-1",
      kind: "sell",
      executedAt: "2026-03-15",
      units: "5",
      pricePerUnit: "200,50",
      currency: "EUR",
      feesMinor: 1_20,
    });
  });

  test("defaults the date to today and fees to zero", () => {
    const draft = parseOperationDraft(
      form({ units: "5", pricePerUnit: "200" }),
      "asset-1",
      "2026-06-24",
      "optimistic-1",
    );

    expect(draft?.executedAt).toBe("2026-06-24");
    expect(draft?.kind).toBe("buy");
    expect(draft?.feesMinor).toBe(0);
  });

  test("carries the captured currency so the row is not read as euros (#1401)", () => {
    const draft = parseOperationDraft(
      form({ units: "0,255", pricePerUnit: "8,00", currency: "USD" }),
      "fidelity",
      "2026-06-24",
      "optimistic-1",
    );

    // No rate is known client-side, so the row shows the dollars it IS — the
    // redirect settles the converted euros.
    expect(draft?.currency).toBe("USD");
    expect(draft?.pricePerUnit).toBe("8,00");
    expect(draft?.capture).toBeUndefined();
  });

  test("returns null when units or price is blank (no ghost row)", () => {
    expect(
      parseOperationDraft(form({ units: "", pricePerUnit: "200" }), "a", "t", "id"),
    ).toBeNull();
    expect(
      parseOperationDraft(form({ units: "5", pricePerUnit: "" }), "a", "t", "id"),
    ).toBeNull();
  });
});

describe("planOperationSubmit · double-submit guard (#1394)", () => {
  const ids = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  test("a first submit mints its own idempotency key", () => {
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({ units: "5", pricePerUnit: "200" }),
      inFlightSubmissionId: null,
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan.kind).toBe("optimistic");
    if (plan.kind !== "optimistic") return;
    // The optimistic row's key and the submission key are distinct ids.
    expect(plan.submissionId).toBe("id-2");
    expect(plan.draft.id).toBe("id-1");
  });

  test("a submit that races an in-flight one REUSES its key", () => {
    // The two clicks the disabled button cannot catch: `isPending` has not
    // flipped yet, so both reach the handler. Same key → same operation id
    // server-side → the second submit writes nothing.
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({ units: "5", pricePerUnit: "200" }),
      inFlightSubmissionId: "already-in-flight",
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan.kind).toBe("optimistic");
    if (plan.kind !== "optimistic") return;
    expect(plan.submissionId).toBe("already-in-flight");
    // ...but the optimistic row still gets a fresh key: two rows must not
    // collide on React's list key while both are in flight.
    expect(plan.draft.id).toBe("id-1");
  });

  test("two settled submits of identical values get different keys", () => {
    // The money-math guard: a split periodic buy is two real operations.
    const newId = ids();
    const values = { units: "5", pricePerUnit: "200" };
    const first = planOperationSubmit({
      assetId: "asset-1",
      formData: form(values),
      inFlightSubmissionId: null,
      newId,
      today: "2026-06-24",
    });
    const second = planOperationSubmit({
      assetId: "asset-1",
      formData: form(values),
      inFlightSubmissionId: null, // the first one settled and rotated the ref
      newId,
      today: "2026-06-24",
    });

    if (first.kind !== "optimistic" || second.kind !== "optimistic") {
      throw new Error("both submits should be optimistic");
    }
    expect(first.submissionId).not.toBe(second.submissionId);
  });

  test("a half-filled submit falls back to the native post", () => {
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({ units: "", pricePerUnit: "200" }),
      inFlightSubmissionId: null,
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan.kind).toBe("native");
  });

  test("a sell past held without confirm asks for confirmation instead of optimism", () => {
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({ kind: "sell", units: "32", pricePerUnit: "10" }),
      heldUnits: "31.999",
      inFlightSubmissionId: null,
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan).toEqual({
      kind: "confirm-oversell",
      message: expect.stringContaining("redondeo del bróker"),
    });
  });

  test("a confirmed oversell proceeds optimistically", () => {
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({
        kind: "sell",
        oversellConfirmed: "1",
        pricePerUnit: "10",
        units: "32",
      }),
      heldUnits: "31.999",
      inFlightSubmissionId: null,
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan.kind).toBe("optimistic");
  });

  test("a buy never asks for oversell confirm", () => {
    const plan = planOperationSubmit({
      assetId: "asset-1",
      formData: form({ kind: "buy", units: "32", pricePerUnit: "10" }),
      heldUnits: "0",
      inFlightSubmissionId: null,
      newId: ids(),
      today: "2026-06-24",
    });

    expect(plan.kind).toBe("optimistic");
  });
});

describe("submitOperationRecord · the wiring the guard rests on (#1394)", () => {
  const plan = {
    draft: op("optimistic-1", "2026-07-31"),
    kind: "optimistic" as const,
    submissionId: "key-1",
  };

  /** Collect what the island hands React and the action. */
  function harness(recordAction: (fd: FormData) => Promise<void>) {
    const keyRef: SubmissionKeyRef = { current: null };
    const added: OperationMutation[] = [];
    let scope: (() => Promise<void>) | null = null;
    return {
      added,
      keyRef,
      run: (formData: FormData) => {
        submitOperationRecord({
          addPending: (mutation) => added.push(mutation),
          formData,
          keyRef,
          plan,
          recordAction,
          startTransition: (fn) => {
            scope = fn;
          },
        });
        return scope as unknown as () => Promise<void>;
      },
    };
  }

  test("stamps the submission key onto the posted body", async () => {
    // Drop this and the server seeds ids off the clock again — two clicks, two
    // operations, the #1394 bug verbatim.
    let posted: FormData | null = null;
    const h = harness(async (fd) => {
      posted = fd;
    });
    const formData = form({ units: "47,96", pricePerUnit: "21,24" });

    await h.run(formData)();

    expect((posted as unknown as FormData).get("submissionId")).toBe("key-1");
  });

  test("publishes the key BEFORE the transition runs, and clears it after", async () => {
    const h = harness(async () => {});
    const scope = h.run(form({ units: "1", pricePerUnit: "1" }));

    // Synchronously visible: the second click of the same frame reads this.
    expect(h.keyRef.current).toBe("key-1");

    await scope();
    expect(h.keyRef.current).toBeNull();
  });

  test("clears the key even when the action rejects", async () => {
    // A failed submit wrote nothing, so the retry must NOT be read as a replay.
    const h = harness(async () => {
      throw new Error("boom");
    });
    const scope = h.run(form({ units: "1", pricePerUnit: "1" }));

    await expect(scope()).rejects.toThrow("boom");
    expect(h.keyRef.current).toBeNull();
  });

  test("adds the optimistic row inside the transition", async () => {
    const h = harness(async () => {});
    const scope = h.run(form({ units: "1", pricePerUnit: "1" }));

    expect(h.added).toHaveLength(0);
    await scope();
    expect(h.added).toEqual([{ kind: "add", operation: plan.draft }]);
  });
});
