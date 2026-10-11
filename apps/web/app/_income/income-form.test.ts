/**
 * The declaration door of an income (#1673, S2 of #1522): the field map a form
 * posts → the write `store.payouts` persists. Pure — no React, no DB.
 *
 * The figures used here are example data. They stand for the shape of a real
 * declaration (a public pension that starts in a future year, read off an official
 * simulation, conditional on contributing until then), never for anyone's amounts.
 */

import { describe, expect, test } from "vitest";

import {
  buildIncomeResult,
  declarationValuesOf,
  type IncomeFields,
  incomeDeclarationFieldsFromForm,
  incomeFieldsFromForm,
  parseIncomeDeclaration,
} from "./income-form";

const TODAY = "2026-10-11";

function fields(over: Partial<IncomeFields> = {}): IncomeFields {
  return {
    label: "Pensión pública",
    amount: "1.500,00",
    cadence: "monthly",
    startISO: "2030-11-01",
    endISO: "",
    expenses: "",
    leaseRegime: "",
    rentRevision: "",
    rentRevisionReference: "",
    postMandatoryTermPolicy: "",
    nature: "",
    amountBasis: "",
    provenance: "official_simulation",
    provenanceAsOf: "2026-08-18",
    assumedContributionThrough: "",
    ...over,
  };
}

describe("buildIncomeResult — a whole future pension goes through", () => {
  test("every declared fact reaches the write, the future start untouched", () => {
    const result = buildIncomeResult(
      fields({
        nature: "passive",
        amountBasis: "real",
        assumedContributionThrough: "2030-10-31",
      }),
      TODAY,
    );

    expect(result).toEqual({
      ok: true,
      income: {
        label: "Pensión pública",
        amountMinor: 150_000,
        cadence: "monthly",
        startISO: "2030-11-01",
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
});

describe("buildIncomeResult — undeclared is a state, never a default", () => {
  test("an untouched nature and basis are written as undeclared, not passive/real", () => {
    const result = buildIncomeResult(fields(), TODAY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.income.nature).toBeNull();
    expect(result.income.amountBasis).toBeNull();
    expect(result.income.assumedContributionThrough).toBeNull();
  });

  test("work and nominal are declarations of their own", () => {
    const result = buildIncomeResult(
      fields({ nature: "work", amountBasis: "nominal" }),
      TODAY,
    );

    expect(result.ok && result.income).toMatchObject({
      nature: "work",
      amountBasis: "nominal",
    });
  });

  test("a value outside either vocabulary is refused, not coerced", () => {
    expect(buildIncomeResult(fields({ nature: "pasiva" }), TODAY)).toEqual({
      ok: false,
      error: "Elige una naturaleza válida para la renta.",
    });
    expect(buildIncomeResult(fields({ amountBasis: "true" }), TODAY)).toEqual({
      ok: false,
      error: "Elige si el importe está en euros de hoy o en euros de cada cobro.",
    });
  });
});

describe("buildIncomeResult — the provenance is not optional", () => {
  test("no source is refused, naming the two it can be", () => {
    expect(buildIncomeResult(fields({ provenance: "" }), TODAY)).toEqual({
      ok: false,
      error:
        "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.",
    });
  });

  test("a source outside the vocabulary is refused", () => {
    expect(buildIncomeResult(fields({ provenance: "banco" }), TODAY)).toEqual({
      ok: false,
      error:
        "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.",
    });
  });

  test("no cut-off date is refused, saying what the date is", () => {
    expect(buildIncomeResult(fields({ provenanceAsOf: "" }), TODAY)).toEqual({
      ok: false,
      error:
        "Indica la fecha de corte de la cifra: el día al que corresponden los datos de los que sale.",
    });
  });

  test("a malformed cut-off date is refused", () => {
    expect(buildIncomeResult(fields({ provenanceAsOf: "2026-02-30" }), TODAY)).toEqual({
      ok: false,
      error: "Introduce una fecha de corte válida.",
    });
  });

  test("a cut-off date after today is refused: data cannot come from the future", () => {
    expect(buildIncomeResult(fields({ provenanceAsOf: "2026-10-12" }), TODAY)).toEqual({
      ok: false,
      error: "La fecha de corte no puede ser posterior a hoy.",
    });
    expect(buildIncomeResult(fields({ provenanceAsOf: TODAY }), TODAY).ok).toBe(true);
  });
});

describe("buildIncomeResult — the condition", () => {
  test("a malformed contribution date is refused", () => {
    expect(
      buildIncomeResult(fields({ assumedContributionThrough: "pronto" }), TODAY),
    ).toEqual({
      ok: false,
      error: "Introduce una fecha válida para la cotización que supone la cifra.",
    });
  });
});

describe("buildIncomeResult — the recurrence rules it shares with the ficha", () => {
  test("the base recurrence is still validated first", () => {
    expect(buildIncomeResult(fields({ amount: "0" }), TODAY)).toEqual({
      ok: false,
      error: "Introduce un importe mayor que cero.",
    });
  });

  test("the ficha's costs and lease terms ride through", () => {
    const result = buildIncomeResult(
      fields({ expenses: "180", leaseRegime: "seasonal", rentRevision: "fixed" }),
      TODAY,
    );

    expect(result.ok && result.income).toMatchObject({
      expensesMinor: 18_000,
      leaseRegime: "seasonal",
      rentRevision: "fixed",
    });
  });
});

describe("incomeFieldsFromForm", () => {
  test("lifts every field, a missing one as the empty string", () => {
    const formData = new FormData();
    formData.set("label", "Pensión pública");
    formData.set("nature", "passive");

    expect(incomeFieldsFromForm(formData)).toEqual(
      fields({
        amount: "",
        cadence: "",
        label: "Pensión pública",
        nature: "passive",
        provenance: "",
        provenanceAsOf: "",
        startISO: "",
      }),
    );
  });
});

describe("a correction never mistakes «not sent» for «sin declarar»", () => {
  test("only the fields the form carried are lifted", () => {
    const formData = new FormData();
    formData.set("provenance", "user_estimate");
    formData.set("provenanceAsOf", "2026-10-01");
    formData.set("nature", "");

    expect(incomeDeclarationFieldsFromForm(formData)).toEqual({
      nature: "",
      provenance: "user_estimate",
      provenanceAsOf: "2026-10-01",
    });
  });

  test("a chosen «Sin declarar» withdraws the declaration; an absent field is left out", () => {
    expect(
      parseIncomeDeclaration(
        { nature: "", provenance: "user_estimate", provenanceAsOf: "2026-10-01" },
        TODAY,
      ),
    ).toEqual({
      ok: true,
      declaration: {
        nature: null,
        provenance: "user_estimate",
        provenanceAsOf: "2026-10-01",
      },
    });
  });

  test("the provenance is still required when the form did not send it", () => {
    expect(parseIncomeDeclaration({ nature: "passive" }, TODAY)).toEqual({
      ok: false,
      error:
        "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.",
    });
  });
});

describe("declarationValuesOf", () => {
  test("prefills a stored declaration, an undeclared one as «Sin declarar»", () => {
    expect(
      declarationValuesOf({
        nature: "passive",
        amountBasis: null,
        provenance: "official_simulation",
        provenanceAsOf: "2026-08-18",
        assumedContributionThrough: null,
      }),
    ).toEqual({
      nature: "passive",
      amountBasis: "",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
      assumedContributionThrough: "",
    });
  });
});
