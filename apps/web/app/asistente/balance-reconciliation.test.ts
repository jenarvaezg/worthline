/**
 * The reconciliation law of a reconstructed debt curve (#1422).
 *
 * The case that wrote this file: Jorge sube el cuadro del Santander, la curva
 * reconstruida deja 51.881 €, su propia curva viva dice 51.887 € y el saldo que
 * tecleó en julio dice 52.375 €. Con igualdad al céntimo contra ese último número
 * el botón nacía muerto y no había NINGUNA forma de aplicar el documento.
 */

import { describe, expect, test } from "vitest";

import {
  anchorDriftSentence,
  balanceToleranceMinor,
  reconcileReconstructedBalance,
  reconciliationSentence,
  redeclarationSentence,
} from "./balance-reconciliation";

/** Plain formatter — the sentences take one so the module stays pure. */
const euros = (minor: number) => `${(minor / 100).toFixed(2)} €`;

/** El caso real de Jorge, al céntimo (issue #1422). */
const JORGE = {
  declaredMinor: 52_375_33,
  modelMinor: 51_886_90,
  resultingMinor: 51_881_00,
};

describe("balanceToleranceMinor", () => {
  test("nunca baja de un euro, por pequeño que sea el saldo", () => {
    expect(balanceToleranceMinor(0)).toBe(100);
    expect(balanceToleranceMinor(50_00)).toBe(100);
  });

  test("crece al 0,1 % del saldo cuando el saldo es grande", () => {
    expect(balanceToleranceMinor(52_375_33)).toBe(5238);
    expect(balanceToleranceMinor(-52_375_33)).toBe(5238);
  });
});

describe("reconcileReconstructedBalance", () => {
  test("el céntimo de redondeo deja de cerrar la puerta", () => {
    const result = reconcileReconstructedBalance({
      declaredMinor: 100_000_00,
      modelMinor: 100_000_00,
      resultingMinor: 100_000_01,
    });

    expect(result.status).toBe("within-tolerance");
    expect(result.matches).toBe(true);
    expect(result.deltaMinor).toBe(1);
  });

  test("la igualdad exacta sigue siendo su propio estado", () => {
    const result = reconcileReconstructedBalance({
      declaredMinor: 100_000_00,
      modelMinor: 148_400_00,
      resultingMinor: 100_000_00,
    });

    expect(result.status).toBe("exact");
    expect(result.against).toBe("declared");
    expect(result.expectedMinor).toBe(100_000_00);
  });

  test("el caso de Jorge cuadra contra la curva viva, no contra el ancla vieja", () => {
    const result = reconcileReconstructedBalance(JORGE);

    expect(result.against).toBe("model");
    expect(result.expectedMinor).toBe(JORGE.modelMinor);
    expect(result.status).toBe("within-tolerance");
    expect(result.matches).toBe(true);
  });

  test("el ancla que ni su propia curva reproduce se marca como a la deriva", () => {
    const result = reconcileReconstructedBalance(JORGE);

    expect(result.anchor).toEqual({
      declaredMinor: 52_375_33,
      driftMinor: 488_43,
      modelMinor: 51_886_90,
      stale: true,
    });
  });

  test("un ancla que su curva sí reproduce no se acusa de nada", () => {
    const result = reconcileReconstructedBalance({
      declaredMinor: 100_000_00,
      modelMinor: 100_000_50,
      resultingMinor: 100_000_00,
    });

    expect(result.anchor.stale).toBe(false);
  });

  test("basta cuadrar con UN testigo: el ancla vale aunque el modelo discrepe", () => {
    const result = reconcileReconstructedBalance({
      declaredMinor: 140_000_00,
      modelMinor: 148_400_00,
      resultingMinor: 140_000_00,
    });

    expect(result.matches).toBe(true);
    expect(result.against).toBe("declared");
  });

  test("un descuadre real contra los dos testigos sigue siendo un descuadre", () => {
    const result = reconcileReconstructedBalance({
      declaredMinor: 140_000_00,
      modelMinor: 148_400_00,
      resultingMinor: 130_000_00,
    });

    expect(result.status).toBe("mismatch");
    expect(result.matches).toBe(false);
    // Se mide contra el testigo MÁS cercano, para que el número que se enseña
    // sea el que menos culpa al documento.
    expect(result.against).toBe("declared");
    expect(result.deltaMinor).toBe(-10_000_00);
  });
});

describe("las frases de la tarjeta", () => {
  test("un descuadre dice lo que va a pasar en vez de solo prohibir", () => {
    const sentence = reconciliationSentence(
      reconcileReconstructedBalance({
        declaredMinor: 140_000_00,
        modelMinor: 148_400_00,
        resultingMinor: 130_000_00,
      }),
      euros,
    );

    expect(sentence).toContain("130000.00 €");
    expect(sentence).toContain("mandará el documento");
    expect(sentence).not.toContain("revisa los puntos");
  });

  test("el ancla a la deriva se nombra con las tres cifras", () => {
    const sentence = anchorDriftSentence(reconcileReconstructedBalance(JORGE), euros);

    expect(sentence).toBe(
      "Tu saldo declarado (52375.33 €) no coincide ni con tu propia curva (51886.90 €); el documento dice 51881.00 €.",
    );
  });

  test("sin deriva no hay frase que sobre", () => {
    expect(
      anchorDriftSentence(
        reconcileReconstructedBalance({
          declaredMinor: 100_000_00,
          modelMinor: 100_000_00,
          resultingMinor: 100_000_00,
        }),
        euros,
      ),
    ).toBeNull();
  });

  test("la redeclaración se anuncia antes de confirmar, no después", () => {
    expect(redeclarationSentence(reconcileReconstructedBalance(JORGE), euros)).toBe(
      "Al confirmar, tu saldo declarado pasará de 52375.33 € a 51881.00 €.",
    );
  });

  test("nada que redeclarar cuando el documento ya dice lo mismo que el ancla", () => {
    expect(
      redeclarationSentence(
        reconcileReconstructedBalance({
          declaredMinor: 100_000_00,
          modelMinor: 100_000_00,
          resultingMinor: 100_000_00,
        }),
        euros,
      ),
    ).toBeNull();
  });
});
