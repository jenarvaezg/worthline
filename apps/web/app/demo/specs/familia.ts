/**
 * familia persona (PRD #297) — a two-member household: a primary residence with
 * an amortizable mortgage, shared ownership splits, a car on the illiquid rung,
 * cash + a term deposit + a modest market investment, and a configured FIRE
 * target. It exercises every rung of the liquidity ladder and the scope axis, so
 * it is the cold-visit default. All figures are fictional and deterministic.
 */
import type { OperationSpec, PersonaSpec } from "@web/demo/spec-types";

const MARTA = "member_marta";
const DIEGO = "member_diego";

const HALF = [
  { memberId: MARTA, shareBps: 5_000 },
  { memberId: DIEGO, shareBps: 5_000 },
];

/** A monthly ladder of buys over `count` months, oldest first — a moving curve. */
function monthlyBuys(assetId: string, count: number, basePrice: number): OperationSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    at: { monthsAgo: count - i },
    id: `${assetId}_op_${i}`,
    kind: "buy" as const,
    pricePerUnit: (basePrice + i).toString(),
    units: "2",
  }));
}

export const FAMILIA_SPEC: PersonaSpec = {
  id: "familia",
  members: [
    { id: MARTA, name: "Marta" },
    { id: DIEGO, name: "Diego" },
  ],
  mode: "household",
  manualAssets: [
    {
      id: "asset_familia_checking",
      liquidityTier: "cash",
      name: "Cuenta corriente conjunta",
      ownership: HALF,
      type: "cash",
      valueMinor: 38_000_00,
    },
    {
      id: "asset_familia_savings",
      liquidityTier: "cash",
      name: "Ahorro de Marta",
      ownership: [{ memberId: MARTA, shareBps: 10_000 }],
      type: "cash",
      valueMinor: 14_500_00,
    },
    {
      id: "asset_familia_deposit",
      liquidityTier: "term-locked",
      name: "Depósito a plazo",
      ownership: HALF,
      type: "cash",
      valueMinor: 20_000_00,
    },
    {
      id: "asset_familia_car",
      liquidityTier: "illiquid",
      name: "Coche familiar",
      ownership: [{ memberId: DIEGO, shareBps: 10_000 }],
      type: "manual",
      valueMinor: 16_500_00,
    },
  ],
  investments: [
    {
      id: "asset_familia_etf",
      manualPricePerUnit: "118.40",
      name: "Fondo indexado global",
      operations: monthlyBuys("asset_familia_etf", 24, 90),
      ownership: HALF,
      unitSymbol: "IDX",
    },
  ],
  housing: [
    {
      acquisition: { at: { yearsAgo: 3 }, valueMinor: 285_000_00 },
      annualAppreciationRate: "0.03",
      id: "asset_familia_home",
      improvements: [
        { at: { monthsAgo: 14 }, id: "asset_familia_home_reno", valueMinor: 9_000_00 },
      ],
      isPrimaryResidence: true,
      mortgage: {
        annualInterestRate: "0.024",
        disbursement: { monthsAgo: 36 },
        earlyRepayments: [
          {
            amountMinor: 8_000_00,
            at: { monthsAgo: 12 },
            id: "repayment_familia_mortgage",
            mode: "reduce-term",
          },
        ],
        firstPayment: { monthsAgo: 35 },
        initialCapitalMinor: 220_000_00,
        liabilityId: "liability_familia_mortgage",
        name: "Hipoteca vivienda",
        ownership: HALF,
        planId: "plan_familia_mortgage",
        termMonths: 360,
      },
      name: "Vivienda habitual",
      ownership: HALF,
    },
  ],
  fire: [
    {
      config: {
        currentAge: 38,
        excludedAssetIds: ["asset_familia_home"],
        expectedRealReturn: 0.05,
        monthlySpendingMinor: 2_800_00,
        safeWithdrawalRate: 0.04,
        targetRetirementAge: 60,
      },
      scopeId: "household",
    },
  ],
};
