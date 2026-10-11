/**
 * The lease terms of a declared rent (#1521) — parsing and the sentence the ficha
 * prints. What is pinned here above all is that declaring NOTHING still produces a
 * sentence: the assumption in force has to be readable, because until #1521 it was
 * invisible and it moved a FIRE date.
 */

import { describe, expect, test } from "vitest";

import {
  type LeaseTermsFields,
  leaseTermsSpec,
  parseLeaseTerms,
} from "./lease-terms-form";

function fields(over: Partial<LeaseTermsFields> = {}): LeaseTermsFields {
  return {
    leaseRegime: "",
    rentRevision: "",
    rentRevisionReference: "",
    postMandatoryTermPolicy: "",
    ...over,
  };
}

describe("parseLeaseTerms", () => {
  test("every field empty is a valid declaration of nothing", () => {
    expect(parseLeaseTerms(fields())).toEqual({
      ok: true,
      terms: {
        leaseRegime: null,
        rentRevision: null,
        rentRevisionReference: null,
        postMandatoryTermPolicy: null,
      },
    });
  });

  test("the three vocabularies come through", () => {
    const result = parseLeaseTerms(
      fields({
        leaseRegime: "residential_long_term",
        rentRevision: "legal_reference",
        rentRevisionReference: "  IRAV  ",
        postMandatoryTermPolicy: "renew_same_real_rent",
      }),
    );
    expect(result).toEqual({
      ok: true,
      terms: {
        leaseRegime: "residential_long_term",
        rentRevision: "legal_reference",
        rentRevisionReference: "IRAV",
        postMandatoryTermPolicy: "renew_same_real_rent",
      },
    });
  });

  test("a reference typed beside a non-legal revision is dropped, not kept contradicting it", () => {
    const result = parseLeaseTerms(
      fields({ rentRevision: "fixed", rentRevisionReference: "IRAV" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.terms.rentRevisionReference).toBeNull();
  });

  test("a value outside the vocabulary is rejected, one message per field", () => {
    expect(parseLeaseTerms(fields({ leaseRegime: "piso" }))).toEqual({
      ok: false,
      error: expect.stringMatching(/régimen/),
    });
    expect(parseLeaseTerms(fields({ rentRevision: "ipc" }))).toEqual({
      ok: false,
      error: expect.stringMatching(/revisión/),
    });
    expect(
      parseLeaseTerms(fields({ postMandatoryTermPolicy: "renew_with_growth" })),
    ).toEqual({ ok: false, error: expect.stringMatching(/plazo obligatorio/) });
  });
});

describe("leaseTermsSpec", () => {
  const bare = {
    leaseRegime: null,
    rentRevision: null,
    rentRevisionReference: null,
    postMandatoryTermPolicy: null,
  } as const;

  test("with nothing declared it names the assumption instead of showing a blank", () => {
    const { spec, warning } = leaseTermsSpec(bare);
    expect(spec).toContain("régimen sin declarar");
    expect(spec).toContain("deja de rentar");
    expect(spec).toContain("supuesto: nadie lo ha declarado");
    expect(warning).toBeNull();
  });

  test("a long-term residential regime alone explains the renewal and where it came from", () => {
    const { spec } = leaseTermsSpec({ ...bare, leaseRegime: "residential_long_term" });
    expect(spec).toContain("Vivienda habitual");
    expect(spec).toContain("sigue rentando lo mismo en términos reales");
    expect(spec).toContain("por el régimen declarado");
  });

  test("an explicit policy is attributed to the owner, not to the regime", () => {
    const { spec } = leaseTermsSpec({
      ...bare,
      leaseRegime: "residential_long_term",
      postMandatoryTermPolicy: "stop",
    });
    expect(spec).toContain("deja de rentar");
    expect(spec).toContain("lo has declarado");
  });

  test("«todavía no lo sé» under a long-term regime is attributed to the regime, not to the owner", () => {
    // What moves the figure is declaring the REGIME, not the indecision: the sentence
    // has to say that, or a user reads «lo has declarado» about a policy he explicitly
    // said he had not decided.
    const { spec } = leaseTermsSpec({
      ...bare,
      leaseRegime: "residential_long_term",
      postMandatoryTermPolicy: "unknown",
    });
    expect(spec).toContain("sigue rentando lo mismo en términos reales");
    expect(spec).toContain("por el régimen declarado");
    expect(spec).not.toContain("lo has declarado");
  });

  test("the legal reference label rides beside its revision", () => {
    const { spec } = leaseTermsSpec({
      ...bare,
      rentRevision: "legal_reference",
      rentRevisionReference: "IRAV",
    });
    expect(spec).toContain("IRAV");
  });

  test("a nominal rent gets the warning that its yield is not read as real", () => {
    for (const rentRevision of ["fixed", "none"] as const) {
      const { warning } = leaseTermsSpec({ ...bare, rentRevision });
      expect(warning).toMatch(/no la lee como rentabilidad real/);
    }
  });
});
