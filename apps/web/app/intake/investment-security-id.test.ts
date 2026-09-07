/**
 * The alta and the ficha ask for the identifier the INSTRUMENT can have (#1746,
 * decisión 9 del mapa #1454): a pension plan has a DGS code, a fund/ETF/stock an
 * ISIN. This is the write boundary of that field — the one that used to read
 * `isin` and only `isin`, so a plan's `N5394` was rejected as a bad ISIN.
 */

import { describe, expect, test } from "vitest";
import {
  parseInvestmentAssetCommandStrict,
  parseOptionalSecurityId,
  parseUpdateInvestmentCommand,
  securityIdToWriteFromFicha,
} from "./investment";

const members = [{ id: "member_jose", name: "Jose" }];

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("parseOptionalSecurityId — one field, the instrument's own identifier", () => {
  test("normalizes a plan code written the way the paper prints it", () => {
    const result = parseOptionalSecurityId("dgs", "n-5394");

    expect(result).toEqual({ ok: true, securityId: { kind: "dgs", value: "N5394" } });
  });

  test("refuses the FUND code with the reason, not a generic «no vale»", () => {
    const result = parseOptionalSecurityId("dgs", "F2244");

    expect(result.ok).toBe(false);
    // The trap of the paper: it prints the fondo's code next to the plan's.
    expect("error" in result && result.error).toContain("F2244");
    expect("error" in result && result.error).toContain("fondo de pensiones");
  });

  test("refuses a plan code in an ISIN field, and an ISIN in a plan field", () => {
    expect(parseOptionalSecurityId("isin", "N5394").ok).toBe(false);
    expect(parseOptionalSecurityId("dgs", "IE00B52MJY50").ok).toBe(false);
  });

  test("blank carries no identity — the field is optional, never blocking", () => {
    expect(parseOptionalSecurityId("dgs", "")).toEqual({ ok: true });
    expect(parseOptionalSecurityId("isin", null)).toEqual({ ok: true });
  });

  test("still normalizes an ISIN to its comparable form", () => {
    expect(parseOptionalSecurityId("isin", " ie00b52mjy50 ")).toEqual({
      ok: true,
      securityId: { kind: "isin", value: "IE00B52MJY50" },
    });
  });
});

describe("the alta writes the pair the pane declared", () => {
  test("a plan's DGS code lands typed as `dgs`", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "MyInvestor S&P 500 PP", securityId: "N5394", securityIdKind: "dgs" }),
      members,
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.securityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("no declared kind keeps the ISIN default — the shape every other door posts", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME", securityId: "ie00b52mjy50" }),
      members,
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.securityId).toEqual({ kind: "isin", value: "IE00B52MJY50" });
  });

  test("a plan asked for an ISIN is refused instead of stored as one", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "Plan", securityId: "IE00B52MJY50", securityIdKind: "dgs" }),
      members,
      1,
    );

    expect(result.ok).toBe(false);
  });
});

describe("the ficha validates by the instrument it is SAVING", () => {
  test("a plan's ficha accepts its DGS code", () => {
    const result = parseUpdateInvestmentCommand(
      form({ instrument: "pension_plan", name: "Plan", securityId: "N5396" }),
      "asset_plan",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.securityId).toEqual({ kind: "dgs", value: "N5396" });
  });

  test("a plan's ficha refuses an ISIN — the state #1745 could not warn about", () => {
    const result = parseUpdateInvestmentCommand(
      form({ instrument: "pension_plan", name: "Plan", securityId: "IE00B52MJY50" }),
      "asset_plan",
    );

    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("DGS");
  });

  test("reclassifying to a plan says WHY the ISIN in the box no longer serves", () => {
    const result = parseUpdateInvestmentCommand(
      form({
        instrument: "pension_plan",
        name: "Plan",
        securityId: "IE00B52MJY50",
        // What the form was RENDERED as: the holding was a fund when it loaded.
        securityIdKind: "isin",
      }),
      "asset_plan",
    );

    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("plan de pensiones");
  });

  test("an instrument with no identifier ignores the field instead of validating it", () => {
    const result = parseUpdateInvestmentCommand(
      form({ instrument: "crypto", name: "Bitcoin", securityId: "" }),
      "asset_btc",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.securityId).toBeUndefined();
  });
});

describe("un guardado no contesta por el campo que su formulario no enseñó", () => {
  test("sin campo (un instrumento sin identificador), lo guardado se conserva", () => {
    expect(
      securityIdToWriteFromFicha({
        formData: form({ instrument: "crypto", name: "Bitcoin" }),
        stored: { kind: "isin", value: "IE00B52MJY50" },
        submitted: undefined,
      }),
    ).toEqual({ kind: "isin", value: "IE00B52MJY50" });
  });

  test("una caja de OTRA clase en blanco tampoco es una respuesta sobre lo guardado", () => {
    // El plan enseña una caja de código DGS y, al lado, la línea que cita el ISIN
    // guardado. Guardar sin teclear no puede ser «bórralo».
    expect(
      securityIdToWriteFromFicha({
        formData: form({ securityIdKind: "dgs" }),
        stored: { kind: "isin", value: "IE00B52MJY50" },
        submitted: undefined,
      }),
    ).toEqual({ kind: "isin", value: "IE00B52MJY50" });
  });

  test("la caja de SU clase en blanco sí borra: eso lo declaró el usuario", () => {
    expect(
      securityIdToWriteFromFicha({
        formData: form({ securityIdKind: "dgs" }),
        stored: { kind: "dgs", value: "N5394" },
        submitted: undefined,
      }),
    ).toBeUndefined();
  });

  test("lo tecleado manda siempre", () => {
    expect(
      securityIdToWriteFromFicha({
        formData: form({ securityIdKind: "dgs" }),
        stored: { kind: "dgs", value: "N5394" },
        submitted: { kind: "dgs", value: "N5396" },
      }),
    ).toEqual({ kind: "dgs", value: "N5396" });
  });

  test("un valor preservado sin clase no puede viajar: la escritura solo acepta par tipado (#1770)", () => {
    expect(
      securityIdToWriteFromFicha({
        formData: form({ securityIdKind: "isin" }),
        stored: { kind: null, value: "LU-1234" },
        submitted: undefined,
      }),
    ).toBeUndefined();
  });
});
