import type { AgentViewCalculationTrace } from "@web/agent-view/contract";
import { describe, expect, it } from "vitest";
import type { MaintainerAlertPayload } from "./maintainer-alert";
import {
  maintainerAlertRefusalFor,
  maintainerAlertRefused,
} from "./maintainer-alert-evidence";

const EUR = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

/** A clean trace: everything reproduces, nothing diverges. */
function traceOver(
  overrides: Partial<AgentViewCalculationTrace> = {},
): AgentViewCalculationTrace {
  return {
    object: "calculation_trace",
    holding: "wl_hld_loan",
    direction: "liability",
    model: "amortizable",
    asOf: "2026-07-30",
    currentValue: EUR(587_900),
    reconciliation: [],
    fidelity: { faithful: true, divergences: [], checkedPoints: 3 },
    tolerance: {
      band: EUR(294),
      referenceBalance: EUR(587_900),
      referenceDate: "2026-07-30",
    },
    omittedReconciliationPoints: 0,
    ...overrides,
  } as unknown as AgentViewCalculationTrace;
}

function payloadOver(
  overrides: Partial<MaintainerAlertPayload> = {},
): MaintainerAlertPayload {
  return {
    category: "infidelity",
    summary: "el saldo pintado no cuadra",
    holding: null,
    calculationTrace: null,
    raisedAt: "2026-07-30T20:12:00.000Z",
    ...overrides,
  };
}

/** The config snapshot the tool assembles, with the painted figure in it. */
function holdingOver(currentValueMinor: number) {
  return {
    id: "wl_hld_loan",
    label: "Fondo indexado",
    direction: "asset",
    instrument: "fund",
    valuationMethod: "market",
    currentValue: EUR(currentValueMinor),
  };
}

const DECLARED = {
  balanceMinor: 559_200,
  currency: "EUR",
  date: "2026-07-30",
  source: "extracto del banco",
};

describe("maintainerAlertRefusalFor · the alert is not a support ticket (#1347)", () => {
  it("refuses an alert that carries no discrepancy at all", () => {
    // The real 2026-07-30 transcript: no declared figure, no trace (a fund has
    // none), and a summary that is the user's WISH — «desea asignar el ISIN…».
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          summary:
            "El usuario desea asignar el ISIN LU0000000000 al fondo, pero propose_correction no lo permite.",
        }),
      ),
    ).toBe("maintainer_alert_without_discrepancy");
  });

  it("refuses it whatever the category, since all three describe magnitudes", () => {
    for (const category of ["infidelity", "residual", "sync_source"] as const) {
      expect(maintainerAlertRefusalFor(payloadOver({ category }))).toBe(
        "maintainer_alert_without_discrepancy",
      );
    }
  });

  it("refuses a clean trace with no declared figure to compare against", () => {
    expect(
      maintainerAlertRefusalFor(payloadOver({ calculationTrace: traceOver() })),
    ).toBe("maintainer_alert_without_discrepancy");
  });

  it("refuses a declared figure the engine itself puts inside the band", () => {
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          declared: DECLARED,
          calculationTrace: traceOver({
            tolerance: {
              band: EUR(294),
              referenceBalance: EUR(587_900),
              referenceDate: "2026-07-30",
              declared: {
                balance: EUR(559_200),
                date: "2026-07-30",
                residual: EUR(-100),
                withinTolerance: true,
              },
            },
          }),
        }),
      ),
    ).toBe("maintainer_alert_figures_agree");
  });

  it("lets through the two conflicting figures when no trace could adjudicate", () => {
    // The trace is scoped to modelled debts; for everything else the painted
    // figure in the snapshot is the counterpart and /admin does the arithmetic.
    expect(
      maintainerAlertRefusalFor(
        payloadOver({ declared: DECLARED, holding: holdingOver(587_900) }),
      ),
    ).toBeNull();
  });

  it("refuses a declared figure that is just the painted one read back", () => {
    // The cheapest way past a gate that only checked «is there a number»: read
    // `get_holding_detail` and hand its own value back as the user's figure.
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          declared: { ...DECLARED, balanceMinor: 587_900 },
          holding: holdingOver(587_900),
        }),
      ),
    ).toBe("maintainer_alert_figures_agree");
  });

  it("does not read a different currency as the same figure twice", () => {
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          declared: { ...DECLARED, balanceMinor: 587_900, currency: "USD" },
          holding: holdingOver(587_900),
        }),
      ),
    ).toBeNull();
  });

  it("keeps a payload from before #1347 raisable on its declared figure alone", () => {
    // `currentValue` is optional because stored payloads predate it; a missing
    // counterpart must not be read as agreement.
    expect(maintainerAlertRefusalFor(payloadOver({ declared: DECLARED }))).toBeNull();
  });

  it("lets a sync_source alert stand on the source itself, with no figure", () => {
    // A source stuck for weeks has no magnitude to declare, and that smell is
    // precisely what the category is for (ADR 0064).
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          category: "sync_source",
          holding: {
            ...holdingOver(587_900),
            source: { adapter: "binance", label: "Binance", lastSyncAt: null },
          },
        }),
      ),
    ).toBeNull();
  });

  it("does not let a manual holding in by relabelling the category", () => {
    // The 2026-07-30 fund was manual: no source, so `sync_source` buys nothing.
    expect(
      maintainerAlertRefusalFor(
        payloadOver({ category: "sync_source", holding: holdingOver(587_900) }),
      ),
    ).toBe("maintainer_alert_without_discrepancy");
  });

  it("lets through a residual the engine puts outside the band", () => {
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          category: "residual",
          declared: DECLARED,
          calculationTrace: traceOver({
            tolerance: {
              band: EUR(294),
              referenceBalance: EUR(587_900),
              referenceDate: "2026-07-30",
              declared: {
                balance: EUR(559_200),
                date: "2026-07-30",
                residual: EUR(-28_700),
                withinTolerance: false,
              },
            },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("lets through an unfaithful trace even with no declared figure", () => {
    // Painted ≠ recomputed is the canonical alert: the engine saw it by itself.
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          calculationTrace: traceOver({
            fidelity: { faithful: false, divergences: [], checkedPoints: 3 },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("lets through a diverging reconciliation point", () => {
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          calculationTrace: traceOver({
            reconciliation: [
              {
                date: "2026-06-30",
                live: EUR(587_900),
                persisted: EUR(560_000),
                difference: EUR(27_900),
                diverges: true,
                isSnapshot: true,
              },
            ],
          }),
        }),
      ),
    ).toBeNull();
  });

  it("does not let a declared figure inside the band mask a real infidelity", () => {
    expect(
      maintainerAlertRefusalFor(
        payloadOver({
          declared: DECLARED,
          calculationTrace: traceOver({
            fidelity: { faithful: false, divergences: [], checkedPoints: 3 },
            tolerance: {
              band: EUR(294),
              referenceBalance: EUR(587_900),
              referenceDate: "2026-07-30",
              declared: {
                balance: EUR(559_200),
                date: "2026-07-30",
                residual: EUR(-100),
                withinTolerance: true,
              },
            },
          }),
        }),
      ),
    ).toBeNull();
  });
});

describe("maintainerAlertRefused · the honest way out", () => {
  it("kills the support-team fiction and routes to the edit sheet", () => {
    const refused = maintainerAlertRefused("maintainer_alert_without_discrepancy");

    expect(refused.error).toBe("maintainer_alert_without_discrepancy");
    // The promise («nuestro equipo lo revisará») is what reached the user, so the
    // message has to say out loud that nobody is behind this channel…
    expect(refused.message).toMatch(/no hay ningún equipo/i);
    expect(refused.message).toMatch(/no es un canal de soporte/i);
    // …and point at where the thing the user asked for is actually done — both
    // surfaces, since the refusal cannot know which complaint it just stopped.
    expect(refused.message).toMatch(/ISIN/);
    expect(refused.message).toMatch(/\/patrimonio/);
    expect(refused.message).toMatch(/\/ajustes\/conexiones/);
  });

  it("explains the figures-agree refusal with no promise of a review", () => {
    const refused = maintainerAlertRefused("maintainer_alert_figures_agree");

    expect(refused.error).toBe("maintainer_alert_figures_agree");
    expect(refused.message).toMatch(/coinciden/i);
    expect(refused.message).toMatch(/tolerancia/i);
    expect(refused.message).toMatch(/equipo de soporte/i);
  });
});
