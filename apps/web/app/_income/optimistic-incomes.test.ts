/**
 * The optimistic half of the income declaration (#1673, interaction-patterns §4/§7):
 * what a submit does before the server answers, how pending changes fold over the
 * server's list, and the submit choreography the islands delegate to. Pure.
 */

import type { Income } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import {
  applyIncomeMutations,
  type IncomeMutation,
  type IncomeSubmitPlan,
  planDeclarationUpdate,
  planIncomeSubmit,
  submitIncomeMutation,
} from "./optimistic-incomes";

const TODAY = "2026-10-11";

function income(over: Partial<Income> = {}): Income {
  return {
    id: "inc_1",
    holdingId: null,
    nature: null,
    amountBasis: null,
    assumedContributionThrough: null,
    provenance: "user_estimate",
    provenanceAsOf: "2026-09-01",
    label: "Nómina",
    amountMinor: 200_000,
    expensesMinor: null,
    cadence: "monthly",
    startISO: "2025-01-01",
    endISO: null,
    exclusions: [],
    ...over,
  };
}

function form(entries: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);
  return formData;
}

const PENSION = {
  label: "Pensión pública",
  amount: "1500",
  cadence: "monthly",
  startISO: "2030-11-01",
  nature: "passive",
  amountBasis: "real",
  provenance: "official_simulation",
  provenanceAsOf: "2026-08-18",
  assumedContributionThrough: "2030-10-31",
};

describe("planIncomeSubmit", () => {
  test("a valid declaration becomes the row exactly as it will be stored", () => {
    const plan = planIncomeSubmit({
      formData: form(PENSION),
      holdingId: null,
      newId: () => "tmp_1",
      today: TODAY,
    });

    expect(plan).toEqual({
      kind: "optimistic",
      mutation: {
        kind: "add",
        income: {
          id: "tmp_1",
          holdingId: null,
          label: "Pensión pública",
          amountMinor: 150_000,
          cadence: "monthly",
          startISO: "2030-11-01",
          endISO: null,
          exclusions: [],
          expensesMinor: null,
          nature: "passive",
          amountBasis: "real",
          provenance: "official_simulation",
          provenanceAsOf: "2026-08-18",
          assumedContributionThrough: "2030-10-31",
          leaseRegime: null,
          rentRevision: null,
          rentRevisionReference: null,
          postMandatoryTermPolicy: null,
        },
      },
    });
  });

  test("the ficha's draft carries the holding it was declared on", () => {
    const plan = planIncomeSubmit({
      formData: form(PENSION),
      holdingId: "asset_flat",
      newId: () => "tmp_1",
      today: TODAY,
    });

    expect(
      plan.kind === "optimistic" &&
        plan.mutation.kind === "add" &&
        plan.mutation.income.holdingId,
    ).toBe("asset_flat");
  });

  test("a refused declaration adds no ghost row and names the reason at once", () => {
    const plan = planIncomeSubmit({
      formData: form({ ...PENSION, provenanceAsOf: "" }),
      holdingId: null,
      newId: () => "tmp_1",
      today: TODAY,
    });

    expect(plan).toEqual({
      kind: "reject",
      error:
        "Indica la fecha de corte de la cifra: el día al que corresponden los datos de los que sale.",
    });
  });
});

describe("planDeclarationUpdate", () => {
  test("a corrected declaration names the income and its new facts", () => {
    expect(
      planDeclarationUpdate({
        formData: form({
          incomeId: "inc_1",
          nature: "work",
          amountBasis: "nominal",
          provenance: "user_estimate",
          provenanceAsOf: "2026-10-01",
          assumedContributionThrough: "",
        }),
        today: TODAY,
      }),
    ).toEqual({
      kind: "optimistic",
      mutation: {
        kind: "update",
        id: "inc_1",
        correction: {
          nature: "work",
          amountBasis: "nominal",
          provenance: "user_estimate",
          provenanceAsOf: "2026-10-01",
          assumedContributionThrough: null,
        },
      },
    });
  });

  test("a field the form did not carry is not part of the correction", () => {
    const plan = planDeclarationUpdate({
      formData: form({
        incomeId: "inc_1",
        provenance: "user_estimate",
        provenanceAsOf: "2026-10-01",
      }),
      today: TODAY,
    });

    expect(plan.kind === "optimistic" && plan.mutation).toEqual({
      kind: "update",
      id: "inc_1",
      correction: { provenance: "user_estimate", provenanceAsOf: "2026-10-01" },
    });
  });

  // #1813: correcting an income with no asset can end it or change its amount, and
  // the row has to show it before the server answers.
  test("the recurrence of an income with no asset folds into the row, an emptied end as none", () => {
    const plan = planDeclarationUpdate({
      formData: form({
        incomeId: "inc_1",
        saveRecurrence: "1",
        label: "Renta vitalicia",
        amount: "1.620,40",
        cadence: "quarterly",
        startISO: "2019-03-01",
        endISO: "",
        provenance: "official_simulation",
        provenanceAsOf: "2026-10-01",
      }),
      today: TODAY,
    });
    expect(plan.kind).toBe("optimistic");

    const [row] = applyIncomeMutations(
      [income({ endISO: "2026-09-01" })],
      plan.kind === "optimistic" ? [plan.mutation] : [],
    );
    expect(row).toMatchObject({
      label: "Renta vitalicia",
      amountMinor: 162_040,
      cadence: "quarterly",
      startISO: "2019-03-01",
      endISO: null,
      provenance: "official_simulation",
      provenanceAsOf: "2026-10-01",
    });
  });

  test("an invalid recurrence is refused before any round-trip, with the door's words", () => {
    expect(
      planDeclarationUpdate({
        formData: form({
          incomeId: "inc_1",
          saveRecurrence: "1",
          label: "Pensión pública",
          amount: "0",
          cadence: "monthly",
          startISO: "2030-11-01",
          endISO: "",
          provenance: "official_simulation",
          provenanceAsOf: "2026-10-01",
        }),
        today: TODAY,
      }),
    ).toEqual({ kind: "reject", error: "Introduce un importe mayor que cero." });
  });

  test("the correction is refused on the same terms as the declaration", () => {
    expect(
      planDeclarationUpdate({
        formData: form({ incomeId: "inc_1", provenance: "", provenanceAsOf: "" }),
        today: TODAY,
      }),
    ).toEqual({
      kind: "reject",
      error:
        "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.",
    });
  });
});

describe("applyIncomeMutations", () => {
  test("folds an add, an update and a delete over the base, never mutating it", () => {
    const base = [income({ id: "a" }), income({ id: "b", label: "Pensión" })];
    const frozen = structuredClone(base);

    const next = applyIncomeMutations(base, [
      { kind: "add", income: income({ id: "c", label: "Renta vitalicia" }) },
      {
        kind: "update",
        id: "a",
        correction: {
          nature: "work",
          amountBasis: "real",
          provenance: "official_simulation",
          provenanceAsOf: "2026-10-01",
          assumedContributionThrough: null,
        },
      },
      { kind: "delete", id: "b" },
    ]);

    expect(next.map((row) => row.id)).toEqual(["a", "c"]);
    expect(next[0]).toMatchObject({
      nature: "work",
      amountBasis: "real",
      provenance: "official_simulation",
      label: "Nómina",
    });
    expect(base).toEqual(frozen);
  });

  test("a correction leaves the declarations it does not name as they were", () => {
    const [row] = applyIncomeMutations(
      [income({ nature: "passive", amountBasis: "real" })],
      [
        {
          kind: "update",
          id: "inc_1",
          correction: {
            provenance: "official_simulation",
            provenanceAsOf: "2026-10-01",
          },
        },
      ],
    );

    expect(row).toMatchObject({
      nature: "passive",
      amountBasis: "real",
      provenance: "official_simulation",
    });
  });
});

describe("submitIncomeMutation", () => {
  const ADD: IncomeMutation = { kind: "add", income: income() };

  /** A transition that runs its scope at once and exposes the promise to await. */
  function harness(overrides: { action?: () => Promise<unknown> } = {}) {
    const calls = {
      action: vi.fn(overrides.action ?? (async () => undefined)),
      rejections: [] as Array<string | null>,
      shown: [] as IncomeMutation[],
      transitions: [] as Array<Promise<void>>,
    };
    const run = (
      plan: () => IncomeSubmitPlan,
      inFlight = { current: false },
      formData = new FormData(),
    ) =>
      submitIncomeMutation({
        action: calls.action as never,
        formData,
        inFlight,
        onRejection: (message) => calls.rejections.push(message),
        plan,
        showOptimistic: (mutation) => calls.shown.push(mutation),
        startTransition: (scope) => {
          calls.transitions.push(scope());
        },
      });
    return { calls, run };
  }

  test("a valid submit shows the mutation, asks for an inline refusal and calls the action", async () => {
    const { calls, run } = harness();
    const formData = new FormData();

    run(() => ({ kind: "optimistic", mutation: ADD }), { current: false }, formData);
    await Promise.all(calls.transitions);

    expect(calls.shown).toEqual([ADD]);
    expect(formData.get("inlineError")).toBe("1");
    expect(calls.action).toHaveBeenCalledTimes(1);
    // The previous refusal is cleared as the retry leaves, and nothing new arrives.
    expect(calls.rejections).toEqual([null, null]);
  });

  test("a refused plan shows its reason and never reaches the server", () => {
    const { calls, run } = harness();

    run(() => ({ kind: "reject", error: "Falta la fecha de corte." }));

    expect(calls.rejections).toEqual(["Falta la fecha de corte."]);
    expect(calls.shown).toEqual([]);
    expect(calls.action).not.toHaveBeenCalled();
  });

  test("a second submit while one is in flight is dropped, plan included", async () => {
    const { calls, run } = harness({ action: () => new Promise(() => {}) });
    const inFlight = { current: false };
    const plan = vi.fn((): IncomeSubmitPlan => ({ kind: "optimistic", mutation: ADD }));

    run(plan, inFlight);
    run(plan, inFlight);

    expect(plan).toHaveBeenCalledTimes(1);
    expect(calls.action).toHaveBeenCalledTimes(1);
    expect(inFlight.current).toBe(true);
  });

  test("the refusal the server hands back reaches the form", async () => {
    const { calls, run } = harness({
      action: async () => ({ ok: false, error: "Renta no encontrada." }),
    });

    run(() => ({ kind: "optimistic", mutation: ADD }));
    await Promise.all(calls.transitions);

    expect(calls.rejections.at(-1)).toBe("Renta no encontrada.");
  });

  test("a failed action still frees the form for a retry", async () => {
    const { calls, run } = harness({
      action: async () => {
        throw new Error("network");
      },
    });
    const inFlight = { current: false };

    run(() => ({ kind: "optimistic", mutation: ADD }), inFlight);
    await expect(Promise.all(calls.transitions)).rejects.toThrow("network");

    expect(inFlight.current).toBe(false);
  });
});
