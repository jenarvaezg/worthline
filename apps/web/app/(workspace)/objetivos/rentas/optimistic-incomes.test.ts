/**
 * The optimistic half of the income declaration (#1673, interaction-patterns §4/§7):
 * what a submit does before the server answers, and how pending changes fold over
 * the server's list. Pure — the islands are thin `useOptimistic` shells over this.
 */

import type { Income } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  applyIncomeMutations,
  planDeclarationUpdate,
  planIncomeSubmit,
  rejectionOf,
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
      draft: {
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
    });
  });

  test("the ficha's draft carries the holding it was declared on", () => {
    const plan = planIncomeSubmit({
      formData: form(PENSION),
      holdingId: "asset_flat",
      newId: () => "tmp_1",
      today: TODAY,
    });

    expect(plan.kind === "optimistic" && plan.draft.holdingId).toBe("asset_flat");
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
      id: "inc_1",
      declaration: {
        nature: "work",
        amountBasis: "nominal",
        provenance: "user_estimate",
        provenanceAsOf: "2026-10-01",
        assumedContributionThrough: null,
      },
    });
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
        declaration: {
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
});

describe("rejectionOf", () => {
  test("reads the refusal an action handed back, and nothing else", () => {
    expect(rejectionOf({ ok: false, error: "No." })).toBe("No.");
    expect(rejectionOf({ ok: true })).toBeNull();
    expect(rejectionOf(undefined)).toBeNull();
  });
});
