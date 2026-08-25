import { describe, expect, it } from "vitest";

import { buildPagarPlan } from "./pagar-view";

const OFFERS_ALL = () => true;

describe("ruta de pago — qué abrir (PRD #1160 S7, #1221)", () => {
  it("un `_ptxn` con forma de transacción abre el checkout", () => {
    expect(
      buildPagarPlan({
        transactionParam: "txn_01ky59cg39ph64b1wc6xy",
        tierParam: undefined,
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "checkout", transactionId: "txn_01ky59cg39ph64b1wc6xy" });
  });

  it("la transacción manda sobre el tier: repetir el enlace de Paddle no compra otra vez", () => {
    expect(
      buildPagarPlan({
        transactionParam: "txn_01ky59cg39ph64b1wc6xy",
        tierParam: "annual",
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "checkout", transactionId: "txn_01ky59cg39ph64b1wc6xy" });
  });

  it("un `_ptxn` que no tiene forma de transacción no llega a Paddle.js", () => {
    for (const param of ["../../etc", "txn_", "sub_01ky59cg39ph64b1wc6xy", "<script>"]) {
      expect(
        buildPagarPlan({
          transactionParam: param,
          tierParam: "monthly",
          offersTier: OFFERS_ALL,
        }),
      ).toEqual({ kind: "unavailable" });
    }
  });

  it("un tier ofertado arranca una transacción nueva", () => {
    expect(
      buildPagarPlan({
        transactionParam: undefined,
        tierParam: "lifetime",
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "start", tier: "lifetime" });
  });

  it("un tier que el proveedor ya no ofrece no abre nada (cupo agotado, #1126)", () => {
    expect(
      buildPagarPlan({
        transactionParam: undefined,
        tierParam: "lifetime",
        offersTier: (tier) => tier !== "lifetime",
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("un tier inventado no abre nada", () => {
    expect(
      buildPagarPlan({
        transactionParam: undefined,
        tierParam: "gratis",
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("sin query no hay pago que abrir", () => {
    expect(
      buildPagarPlan({
        transactionParam: undefined,
        tierParam: undefined,
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("un parámetro repetido se resuelve por el primer valor", () => {
    expect(
      buildPagarPlan({
        transactionParam: ["txn_01ky59cg39ph64b1wc6xy", "txn_otro"],
        tierParam: undefined,
        offersTier: OFFERS_ALL,
      }),
    ).toEqual({ kind: "checkout", transactionId: "txn_01ky59cg39ph64b1wc6xy" });
  });
});
