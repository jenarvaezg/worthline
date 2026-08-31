import { describe, expect, test } from "vitest";

import type { FireScopeConfig } from "./fire";
import {
  assessSpendingDebtService,
  describeSpendingDebtServiceGap,
  scopeMonthlyDebtService,
  spendingDebtServiceCoverageNote,
  spendingDebtServiceDeclaration,
  spendingDebtServiceSustainableNote,
} from "./spending-debt-service";
import type { Liability } from "./workspace-types";

const config = (overrides: Partial<FireScopeConfig> = {}): FireScopeConfig => ({
  monthlySpendingMinor: 2_000_00,
  safeWithdrawalRate: 0.04,
  ...overrides,
});

const liability = (overrides: Partial<Liability> = {}): Liability => ({
  currency: "EUR",
  currentBalance: { amountMinor: 100_000_00, currency: "EUR" },
  id: "liab_1",
  name: "Hipoteca",
  ownership: [{ memberId: "m1", shareBps: 10_000 }],
  type: "mortgage",
  ...overrides,
});

const noDebtService = scopeMonthlyDebtService({
  currency: "EUR",
  debtServiceByLiabilityId: new Map(),
  liabilities: [],
  scopeMemberIds: new Set(["m1"]),
});

describe("spendingDebtServiceDeclaration: tres estados, no un booleano (#1520)", () => {
  test("sin el campo, el gasto declarado no dice nada — y eso es un estado", () => {
    expect(spendingDebtServiceDeclaration(config())).toBe("undeclared");
  });

  test("declarado en cualquiera de los dos sentidos, se lee tal cual", () => {
    expect(
      spendingDebtServiceDeclaration(
        config({ monthlySpendingIncludesDebtService: true }),
      ),
    ).toBe("included");
    expect(
      spendingDebtServiceDeclaration(
        config({ monthlySpendingIncludesDebtService: false }),
      ),
    ).toBe("excluded");
  });
});

describe("scopeMonthlyDebtService: la cuota del ámbito (#1520)", () => {
  test("suma las cuotas escaladas a la participación del ámbito", () => {
    const measured = scopeMonthlyDebtService({
      currency: "EUR",
      debtServiceByLiabilityId: new Map([
        ["liab_1", 800_00],
        ["liab_2", 100_00],
      ]),
      liabilities: [
        liability({ id: "liab_1" }),
        liability({
          id: "liab_2",
          name: "Préstamo compartido",
          ownership: [
            { memberId: "m1", shareBps: 5_000 },
            { memberId: "m2", shareBps: 5_000 },
          ],
        }),
      ],
      scopeMemberIds: new Set(["m1"]),
    });

    // 800 € al 100 % + 100 € al 50 %: la misma ponderación con la que el pool FIRE
    // netea el saldo de esas mismas deudas.
    expect(measured.monthlyMinor).toBe(850_00);
    expect(measured.liabilityCount).toBe(2);
    expect(measured.skippedForeignCount).toBe(0);
  });

  test("una deuda de fuera del ámbito no pesa en él", () => {
    const measured = scopeMonthlyDebtService({
      currency: "EUR",
      debtServiceByLiabilityId: new Map([["liab_1", 800_00]]),
      liabilities: [liability({ ownership: [{ memberId: "m2", shareBps: 10_000 }] })],
      scopeMemberIds: new Set(["m1"]),
    });

    expect(measured.monthlyMinor).toBe(0);
    expect(measured.liabilityCount).toBe(0);
  });

  test("una cuota en otra divisa se cuenta como saltada, nunca como euros", () => {
    const measured = scopeMonthlyDebtService({
      currency: "EUR",
      debtServiceByLiabilityId: new Map([["liab_1", 800_00]]),
      liabilities: [liability({ currency: "USD" })],
      scopeMemberIds: new Set(["m1"]),
    });

    expect(measured.monthlyMinor).toBe(0);
    expect(measured.skippedForeignCount).toBe(1);
  });

  test("una deuda sin cuota conocida (revolving, informal) no entra", () => {
    const measured = scopeMonthlyDebtService({
      currency: "EUR",
      debtServiceByLiabilityId: new Map(),
      liabilities: [liability({ name: "Tarjeta", type: "debt" })],
      scopeMemberIds: new Set(["m1"]),
    });

    expect(measured.monthlyMinor).toBe(0);
    expect(measured.liabilityCount).toBe(0);
  });
});

describe("assessSpendingDebtService: el careo (#1520)", () => {
  const debtServiceOf = (monthlyMinor: number) =>
    scopeMonthlyDebtService({
      currency: "EUR",
      debtServiceByLiabilityId: new Map([["liab_1", monthlyMinor]]),
      liabilities: [liability()],
      scopeMemberIds: new Set(["m1"]),
    });

  test("sin cuotas vigentes no hay nada que cruzar", () => {
    const coherence = assessSpendingDebtService({
      config: config(),
      debtService: noDebtService,
    });

    expect(coherence.state).toBe("no_debt_service");
    expect(coherence.debtServiceMonthlyMinor).toBe(0);
  });

  test("declarar que el gasto incluye una cuota mayor que el gasto es imposible", () => {
    const coherence = assessSpendingDebtService({
      config: config({
        monthlySpendingIncludesDebtService: true,
        monthlySpendingMinor: 800_00,
      }),
      debtService: debtServiceOf(883_66),
    });

    expect(coherence.state).toBe("impossible");
    expect(describeSpendingDebtServiceGap(coherence, "EUR")).toContain("883,66");
  });

  test("declarado que lo incluye y cabe: nada que avisar", () => {
    const coherence = assessSpendingDebtService({
      config: config({ monthlySpendingIncludesDebtService: true }),
      debtService: debtServiceOf(883_66),
    });

    expect(coherence.state).toBe("aligned");
  });

  test("sin declaración y con una cuota que cambia la lectura, se pide la declaración", () => {
    // El caso real: 883,66 € de cuotas contra 2.000 € de gasto declarado — el 44 %.
    const coherence = assessSpendingDebtService({
      config: config(),
      debtService: debtServiceOf(883_66),
    });

    expect(coherence.state).toBe("undeclared");
    const sentence = describeSpendingDebtServiceGap(coherence, "EUR");
    expect(sentence).toContain("883,66");
    expect(sentence).toContain("2000,00");
  });

  test("sin declaración pero con una cuota que no mueve la lectura, silencio", () => {
    const coherence = assessSpendingDebtService({
      config: config(),
      debtService: debtServiceOf(40_00),
    });

    expect(coherence.state).toBe("aligned");
    expect(coherence.ratio).toBeCloseTo(0.02, 3);
  });

  test("declarar que NO lo incluye es una respuesta completa: no se vuelve a preguntar", () => {
    const coherence = assessSpendingDebtService({
      config: config({ monthlySpendingIncludesDebtService: false }),
      debtService: debtServiceOf(883_66),
    });

    expect(coherence.state).toBe("aligned");
  });
});

describe("las glosas de las dos tarjetas (#1520)", () => {
  const withDebt = (declaration?: boolean) =>
    assessSpendingDebtService({
      config: config(
        declaration === undefined
          ? {}
          : { monthlySpendingIncludesDebtService: declaration },
      ),
      debtService: scopeMonthlyDebtService({
        currency: "EUR",
        debtServiceByLiabilityId: new Map([["liab_1", 883_66]]),
        liabilities: [liability()],
        scopeMemberIds: new Set(["m1"]),
      }),
    });

  test("sin cuotas vigentes las dos tarjetas callan: no hay supuesto que nombrar", () => {
    const coherence = assessSpendingDebtService({
      config: config(),
      debtService: noDebtService,
    });

    expect(spendingDebtServiceCoverageNote(coherence, "EUR")).toBeNull();
    expect(spendingDebtServiceSustainableNote(coherence, "EUR")).toBeNull();
  });

  test("los tres estados se nombran, el de sin declarar incluido", () => {
    for (const declaration of [true, false, undefined] as const) {
      const coherence = withDebt(declaration);
      const coverage = spendingDebtServiceCoverageNote(coherence, "EUR");
      const sustainable = spendingDebtServiceSustainableNote(coherence, "EUR");

      expect(coverage).not.toBeNull();
      expect(sustainable).not.toBeNull();
      expect(coverage).toContain("883,66");
      expect(sustainable).toContain("883,66");
    }
  });

  test("sin declarar, las dos glosas piden la declaración", () => {
    expect(spendingDebtServiceCoverageNote(withDebt(), "EUR")).toContain("declarado");
    expect(spendingDebtServiceSustainableNote(withDebt(), "EUR")).toContain("declarado");
  });

  test("el gasto sostenible dice que la cuota sale de esa cifra, y que no se ha restado", () => {
    const note = spendingDebtServiceSustainableNote(withDebt(true), "EUR")!;

    expect(note).toContain("no se han restado");
  });

  test("en modo privacidad ninguna glosa filtra la cifra", () => {
    const coherence = withDebt();

    expect(spendingDebtServiceCoverageNote(coherence, "EUR", true)).not.toContain("883");
    expect(spendingDebtServiceSustainableNote(coherence, "EUR", true)).not.toContain(
      "883",
    );
  });
});
