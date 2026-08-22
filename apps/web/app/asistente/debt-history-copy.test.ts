import type { DebtRippleCounts } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  historyReconstructedCopy,
  snapshotMembershipAllowsConfirm,
  snapshotMembershipNotice,
} from "./debt-history-copy";

/**
 * El copy compartido por las DOS lanes que materializan una reconstrucción
 * (#1438). Puro a propósito: estas aserciones fijan las frases exactas que las
 * tarjetas renderizan sin montar el layer entero.
 */
describe("debt-history-copy · preflight de membresía (#1438)", () => {
  test("omisión total: error y la frase honesta", () => {
    expect(
      snapshotMembershipNotice({ missing: 256, startDate: "2024-01-01", total: 256 }),
    ).toEqual({
      className: "assistantError",
      text: "Ninguno de los 256 puntos escribirá esta deuda en el histórico: no existiría en esas fechas.",
    });
    expect(snapshotMembershipAllowsConfirm({ missing: 256, total: 256 })).toBe(false);
  });

  test("omisión parcial: aviso, Confirmar sigue vivo", () => {
    expect(snapshotMembershipNotice({ missing: 5, total: 12 })).toEqual({
      className: "assistantWarning",
      text: "5 de 12 puntos no incluirán esta deuda (anteriores al inicio). El resto sí.",
    });
    expect(snapshotMembershipAllowsConfirm({ missing: 5, total: 12 })).toBe(true);
  });

  test("membresía completa o ausente: nada nuevo, Confirmar vivo", () => {
    expect(snapshotMembershipNotice(undefined)).toBeNull();
    expect(snapshotMembershipNotice({ missing: 0, total: 12 })).toBeNull();
    expect(snapshotMembershipAllowsConfirm(undefined)).toBe(true);
    expect(snapshotMembershipAllowsConfirm({ missing: 0, total: 0 })).toBe(true);
  });
});

describe("debt-history-copy · la frase del confirm (#1438)", () => {
  const counts = (
    generated: number,
    generatedWithLiability: number,
    recalculated: number,
  ): DebtRippleCounts => ({ generated, generatedWithLiability, recalculated });

  test("todo con la deuda: frase limpia de éxito", () => {
    expect(historyReconstructedCopy(counts(256, 256, 10))).toEqual({
      className: "assistantOk",
      text: "Historia reconstruida · 266 capturas.",
    });
  });

  test("omisión parcial: las capturas sin la deuda se nombran, con aviso", () => {
    expect(historyReconstructedCopy(counts(256, 234, 10))).toEqual({
      className: "assistantWarning",
      text: "Historia reconstruida · 266 capturas, 22 sin la deuda.",
    });
  });

  test("cero generadas (solo recálculo): no hay M que contar", () => {
    expect(historyReconstructedCopy(counts(0, 0, 4))).toEqual({
      className: "assistantOk",
      text: "Historia reconstruida · 4 capturas.",
    });
  });
});
