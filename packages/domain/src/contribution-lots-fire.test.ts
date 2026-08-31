/**
 * Los lotes de aportación, de punta a punta (#1676, fase 2 de #1528).
 *
 * `contribution-lots.test.ts` fija la aritmética y `fire-eligible-pool.test.ts` el
 * reparto por propiedad. Lo que falta —y es lo que la casilla de aceptación pide de
 * verdad— es que el **gasto sostenible de agotamiento** cambie de respuesta: la cadena
 * entera desde un holding con lotes hasta la cifra que el usuario lee.
 *
 * Y el invariante que el ticket subraya: los lotes son un reparto de **liquidez**,
 * jamás de base fiscal. Ni una unidad, ni un céntimo de coste, ni una cifra de
 * rentabilidad se mueven porque alguien declare una escalera.
 */

import { describe, expect, it } from "vitest";
import type { ContributionLot } from "./contribution-lots";
import { calculateFireForScope } from "./fire";
import { fireSustainableSpending } from "./fire-sustainable-spending";
import type { ManualAsset, Workspace } from "./index";

const TODAY = "2026-08-31";

const workspace: Workspace = {
  baseCurrency: "EUR",
  mode: "individual",
  members: [{ id: "alice", name: "Alice" }],
  groups: [],
};

const CONFIG = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
  currentAge: 60,
  capitalLastsUntilAge: 90,
  expectedRealReturn: 0.03,
} as const;

function pensionPlan(amountMinor: number, lots?: ContributionLot[]): ManualAsset {
  return {
    id: "pp",
    name: "Plan de pensiones",
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier: "term-locked",
    ownership: [{ memberId: "alice", shareBps: 10_000 }],
    isPrimaryResidence: false,
    ...(lots ? { contributionLots: lots } : {}),
  };
}

const fireFor = (assets: ManualAsset[]) =>
  calculateFireForScope(CONFIG, assets, [], workspace, "alice", 0, { todayISO: TODAY });

const spendingFor = (assets: ManualAsset[]) => {
  const fire = fireFor(assets);
  return fireSustainableSpending({
    availability: fire.availability,
    capitalSplit: fire.capitalSplit,
    context: fire.context,
    rentReturns: fire.rentReturns,
  });
};

describe("el reparto de agotamiento respeta los lotes (#1676)", () => {
  it("no reparte, en los primeros años, el tramo que todavía no ha vencido", () => {
    const conEscalera = spendingFor([
      pensionPlan(1_000_000, [
        { amountMinor: 100_000, availableFrom: "2024-03-01" },
        { amountMinor: 900_000, availableFrom: "2040-05-01" },
      ]),
    ]);

    expect(conEscalera?.depletion?.limitedByAvailability).toBe(true);
    // Y el bloqueo que la tarjeta nombra es el tramo pendiente, no el plan entero.
    expect(conEscalera?.availability.lockedMinor).toBe(900_000);
    expect(conEscalera?.availability.tranches).toEqual([
      { amountMinor: 900_000, yearsUntil: 14 },
    ]);
  });

  // La mitad que la fase 1 no sabía decir: un plan con parte ya rescatable reparte MÁS
  // que el mismo plan declarado como un bloque bloqueado hasta la misma fecha.
  it("una escalera reparte más que el bloque todo-o-nada equivalente", () => {
    const escalera = spendingFor([
      pensionPlan(1_000_000, [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 600_000, availableFrom: "2040-05-01" },
      ]),
    ]);
    const bloque = spendingFor([
      { ...pensionPlan(1_000_000), availableFrom: "2040-05-01" },
    ]);

    expect(escalera?.depletion?.capital.annualMinor).toBeGreaterThan(
      bloque?.depletion?.capital.annualMinor ?? 0,
    );
  });

  it("con todos los lotes vencidos la cifra es la de un capital sin bloqueos", () => {
    const vencidos = spendingFor([
      pensionPlan(1_000_000, [
        { amountMinor: 400_000, availableFrom: "2014-03-01" },
        { amountMinor: 600_000, availableFrom: "2016-01-01" },
      ]),
    ]);
    const sinDeclararNada = spendingFor([pensionPlan(1_000_000)]);

    expect(vencidos?.depletion?.limitedByAvailability).toBe(false);
    expect(vencidos?.depletion?.capital.annualMinor).toBe(
      sinDeclararNada?.depletion?.capital.annualMinor,
    );
  });

  // Sin lotes ni fecha, el hueco con nombre que #1528 ya sabía decir.
  it("lo que los lotes no cubren llega a la tarjeta como capital a plazo sin fecha", () => {
    const parcial = spendingFor([
      pensionPlan(1_055_658, [{ amountMinor: 400_000, availableFrom: "2024-03-01" }]),
    ]);

    expect(parcial?.availability.undeclaredMinor).toBe(655_658);
  });
});

// ---------------------------------------------------------------------------
// El invariante del ticket: los lotes son LIQUIDEZ, nunca base fiscal.
// ---------------------------------------------------------------------------

describe("declarar lotes no mueve ninguna cifra que no sea de liquidez (#1676)", () => {
  const sinLotes = fireFor([pensionPlan(1_000_000)]);
  const conLotes = fireFor([
    pensionPlan(1_000_000, [
      { amountMinor: 400_000, availableFrom: "2024-03-01" },
      { amountMinor: 600_000, availableFrom: "2040-05-01" },
    ]),
  ]);

  it("no mueve el capital elegible, ni el número FIRE, ni el porcentaje financiado", () => {
    expect(conLotes.eligibleAssets).toEqual(sinLotes.eligibleAssets);
    expect(conLotes.fireNumber).toEqual(sinLotes.fireNumber);
    expect(conLotes.percentFunded).toBe(sinLotes.percentFunded);
  });

  it("no mueve el retorno esperado ponderado: la escalera no es un peldaño", () => {
    expect(conLotes.context.effectiveRealReturn).toBe(
      sinLotes.context.effectiveRealReturn,
    );
    expect(conLotes.returnMix).toEqual(sinLotes.returnMix);
  });

  it("no mueve el reparto vendible/inmovilizado: sigue siendo el mismo peldaño", () => {
    expect(conLotes.capitalSplit).toEqual(sinLotes.capitalSplit);
  });

  // La versión perpetua no toca el principal, así que un calendario no la puede mover.
  it("no mueve el gasto sostenible perpetuo, que no reparte por años", () => {
    const conEscalera = spendingFor([
      pensionPlan(1_000_000, [
        { amountMinor: 400_000, availableFrom: "2024-03-01" },
        { amountMinor: 600_000, availableFrom: "2040-05-01" },
      ]),
    ]);
    const sinEscalera = spendingFor([pensionPlan(1_000_000)]);

    expect(conEscalera?.perpetual).toEqual(sinEscalera?.perpetual);
  });
});
