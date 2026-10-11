/**
 * Tests for deriveStandaloneIncomes (#1674, S3 de #1522).
 * Run: cd packages/domain && npx vitest run fire-standalone-income
 */
import { describe, expect, it } from "vitest";

import { deriveStandaloneIncomes } from "./fire-standalone-income";
import type { Income } from "./payouts";
import type { Member } from "./workspace-types";
import { createWorkspace } from "./workspace-types";

const TODAY = "2026-10-11";

const JORGE: Member = { birthMonth: 11, birthYear: 1963, id: "m-jorge", name: "Jorge" };
const ANA: Member = { birthYear: 1966, id: "m-ana", name: "Ana" };

const SOLO = createWorkspace({ members: [JORGE], mode: "individual" });
const COUPLE = createWorkspace({
  groups: [{ id: "g-both", memberIds: ["m-jorge", "m-ana"], name: "Los dos" }],
  members: [JORGE, ANA],
  mode: "household",
});

/** La pensión de la simulación oficial: pasiva, real, sin activo, desde 2030. */
function pension(overrides: Partial<Income> = {}): Income {
  return {
    amountBasis: "real",
    amountMinor: 338_356,
    assumedContributionThrough: "2030-11-30",
    cadence: "monthly",
    endISO: null,
    exclusions: [],
    holdingId: null,
    id: "inc-pension",
    label: "Pensión",
    nature: "passive",
    provenance: "official_simulation",
    provenanceAsOf: "2026-08-18",
    startISO: "2030-12-10",
    ...overrides,
  };
}

function derive(incomes: Income[], workspace = SOLO, scopeId = "household") {
  return deriveStandaloneIncomes({ incomes, scopeId, todayISO: TODAY, workspace });
}

describe("deriveStandaloneIncomes — qué renta sin activo puede leer la tarjeta", () => {
  it("una pasiva y real que empieza más adelante se lee con su fecha, su procedencia y su condición", () => {
    const report = derive([pension()]);

    expect(report.readable).toEqual([
      {
        annualMinor: 4_060_272,
        assumedContributionThrough: "2030-11-30",
        endISO: null,
        incomeId: "inc-pension",
        label: "Pensión",
        provenance: "official_simulation",
        provenanceAsOf: "2026-08-18",
        startISO: "2030-12-10",
        startsLater: true,
      },
    ]);
    expect(report.withheld).toEqual([]);
  });

  it("una vigente hoy se lee sin fecha por delante", () => {
    const report = derive([pension({ startISO: "2024-01-01" })]);

    expect(report.readable.map((income) => income.startsLater)).toEqual([false]);
  });

  it("resta los gastos declarados y, sin declarar, no resta nada: una pensión no paga IBI", () => {
    const report = derive([
      pension({ amountMinor: 100_000, expensesMinor: 10_000, id: "a" }),
      pension({ amountMinor: 100_000, id: "b" }),
    ]);

    expect(report.readable.map((income) => income.annualMinor)).toEqual([
      1_080_000, 1_200_000,
    ]);
  });

  it("anualiza por su cadencia: la paga extra trimestral son cuatro al año", () => {
    const report = derive([
      pension({ amountMinor: 169_178, cadence: "quarterly", label: "Paga extra" }),
    ]);

    expect(report.readable[0]?.annualMinor).toBe(676_712);
  });

  it("una que ya terminó no es nada que la tarjeta tenga que decir", () => {
    const report = derive([pension({ endISO: "2025-12-31", startISO: "2020-01-01" })]);

    expect(report).toMatchObject({ readable: [], withheld: [] });
  });

  it("una enlazada a un activo no es suya: la lee el camino de su activo (ADR 0076)", () => {
    const report = derive([pension({ holdingId: "asset-flat" })]);

    expect(report).toMatchObject({ readable: [], withheld: [] });
  });
});

describe("deriveStandaloneIncomes — las que no entran dicen por qué", () => {
  it.each([
    [{ nature: null }, "missing_nature"],
    [{ nature: "work" as const }, "work_income"],
    [{ amountBasis: null }, "missing_amount_basis"],
    [{ amountBasis: "nominal" as const }, "nominal_amount"],
  ])("%o queda fuera como %s", (overrides, reason) => {
    const report = derive([pension(overrides)]);

    expect(report.readable).toEqual([]);
    expect(report.withheld).toEqual([
      { incomeId: "inc-pension", label: "Pensión", reason },
    ]);
  });
});

describe("deriveStandaloneIncomes — una renta sin activo no tiene dueño declarado", () => {
  it("cuenta entera en un ámbito que cubre a todos los miembros", () => {
    expect(derive([pension()], COUPLE, "household").readable).toHaveLength(1);
    expect(derive([pension()], COUPLE, "g-both").readable).toHaveLength(1);
  });

  it("en el ámbito de un solo miembro no se le atribuye a nadie, y lo dice antes que cualquier otra razón", () => {
    const report = derive([pension({ nature: null })], COUPLE, "m-ana");

    expect(report.readable).toEqual([]);
    expect(report.withheld).toEqual([
      { incomeId: "inc-pension", label: "Pensión", reason: "ownerless_in_partial_scope" },
    ]);
  });
});

describe("deriveStandaloneIncomes — la fecha de nacimiento contra la que se mide la condición", () => {
  it("es la del miembro de referencia del ámbito, el mayor (ADR 0073)", () => {
    expect(derive([pension()], COUPLE).referenceBirth).toEqual({
      birthMonth: 11,
      birthYear: 1963,
    });
  });

  it("sin ninguna fecha de nacimiento es null, no una inventada", () => {
    const ageless = createWorkspace({
      members: [{ id: "m-x", name: "X" }],
      mode: "individual",
    });

    expect(derive([pension()], ageless).referenceBirth).toBeNull();
  });

  it("las rentas se ordenan por cuándo empiezan, como se leen en la tarjeta", () => {
    const report = derive([
      pension({ id: "late", startISO: "2031-01-01" }),
      pension({ id: "soon", startISO: "2030-11-10" }),
    ]);

    expect(report.readable.map((income) => income.incomeId)).toEqual(["soon", "late"]);
  });
});
