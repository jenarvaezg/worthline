import { describe, expect, test } from "vitest";

import { debtFichaShape } from "./debt-ficha-shape";

/**
 * The debt ficha's bar and tabs, model by model (#1848): the table of the ticket,
 * row by row. Each action is offered only where its form is today — revision and
 * anticipada need a plan, recalibrar a curve, «Actualizar saldo» a debt whose stored
 * balance is still its figure (#1290).
 */
const shape = (
  debtModel: "amortizable" | "revolving" | "informal" | null,
  rows: { plan?: boolean; rebaselines?: boolean; anchors?: boolean } = {},
) =>
  debtFichaShape({
    debtModel,
    hasAmortizationPlan: rows.plan ?? false,
    hasBalanceAnchors: rows.anchors ?? false,
    hasBalanceRebaselines: rows.rebaselines ?? false,
  });

describe("debtFichaShape", () => {
  test("amortizable with a plan: anticipada first, revision and recalibrar at hand, the model in «Más»", () => {
    expect(shape("amortizable", { plan: true })).toEqual({
      actions: [
        { key: "anticipada", tier: "primary" },
        { key: "revision", tier: "secondary" },
        { key: "recalibrar", tier: "secondary" },
        { key: "modelo", tier: "more" },
      ],
      tabs: ["plan", "revisiones", "anticipadas"],
    });
  });

  test("amortizable with only a re-baseline: recalibrar is the habitual action, Plan the one tab", () => {
    expect(shape("amortizable", { rebaselines: true })).toEqual({
      actions: [
        { key: "recalibrar", tier: "primary" },
        { key: "modelo", tier: "more" },
      ],
      tabs: ["plan"],
    });
  });

  test("amortizable with no curve yet: its stored balance is the figure, so «Actualizar saldo» leads", () => {
    expect(shape("amortizable")).toEqual({
      actions: [
        { key: "saldo-pendiente", tier: "primary" },
        { key: "modelo", tier: "more" },
      ],
      tabs: ["plan"],
    });
  });

  test.each([
    "revolving",
    "informal",
  ] as const)("%s with no balances yet: «Registrar saldo» leads, «Actualizar saldo» waits in «Más»", (model) => {
    expect(shape(model)).toEqual({
      actions: [
        { key: "saldo", tier: "primary" },
        { key: "saldo-pendiente", tier: "more" },
        { key: "modelo", tier: "more" },
      ],
      tabs: ["saldos"],
    });
  });

  test("revolving with a balance declared: the stored balance governs nothing, so its door is gone", () => {
    expect(shape("revolving", { anchors: true })).toEqual({
      actions: [
        { key: "saldo", tier: "primary" },
        { key: "modelo", tier: "more" },
      ],
      tabs: ["saldos"],
    });
  });

  test("no model: choosing one is the habitual action, and the debt has no tab of its own", () => {
    expect(shape(null)).toEqual({
      actions: [
        { key: "modelo", tier: "primary" },
        { key: "saldo-pendiente", tier: "secondary" },
      ],
      tabs: [],
    });
  });
});
