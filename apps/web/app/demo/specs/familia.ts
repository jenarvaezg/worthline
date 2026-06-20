/**
 * familia persona (PRD #297) — a two-member household: a primary residence with
 * an amortizable mortgage, early repayments, shared ownership splits, a car loan,
 * a car on the illiquid rung, cash buffers, term-locked savings, a market
 * portfolio with contributions and one sale, and a configured FIRE target. It
 * exercises every rung of the liquidity ladder, debt modelling, and the scope
 * axis, so it is the cold-visit default. All figures are fictional.
 */
import type { OperationSpec, PersonaSpec } from "@web/demo/spec-types";

const MARTA = "member_marta";
const DIEGO = "member_diego";

const HALF = [
  { memberId: MARTA, shareBps: 5_000 },
  { memberId: DIEGO, shareBps: 5_000 },
];

/** A monthly ladder of buys over `count` months, oldest first — a moving curve. */
function monthlyBuys(
  assetId: string,
  count: number,
  units: string,
  basePrice: number,
  step = 1,
): OperationSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    at: { monthsAgo: count - i },
    id: `${assetId}_op_${i}`,
    kind: "buy" as const,
    pricePerUnit: (basePrice + i * step).toFixed(2),
    units,
    feesMinor: 100,
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
      valueMinor: 9_800_00,
    },
    {
      id: "asset_familia_savings",
      liquidityTier: "cash",
      name: "Fondo de emergencia",
      ownership: HALF,
      type: "cash",
      valueMinor: 24_000_00,
    },
    {
      id: "asset_familia_deposit",
      liquidityTier: "term-locked",
      name: "Depósito a 12 meses",
      ownership: HALF,
      type: "cash",
      valueMinor: 18_000_00,
    },
    {
      id: "asset_familia_children",
      liquidityTier: "term-locked",
      name: "Ahorro estudios peques",
      ownership: HALF,
      type: "cash",
      valueMinor: 7_200_00,
    },
    {
      id: "asset_familia_car",
      liquidityTier: "illiquid",
      name: "Coche familiar",
      ownership: [{ memberId: DIEGO, shareBps: 10_000 }],
      type: "manual",
      valueMinor: 13_800_00,
    },
  ],
  investments: [
    {
      id: "asset_familia_etf",
      manualPricePerUnit: "137.20",
      name: "Cartera indexada familiar",
      operations: [
        ...monthlyBuys("asset_familia_etf", 42, "3", 92, 0.85),
        {
          at: { monthsAgo: 10 },
          id: "asset_familia_etf_rebalance_0",
          kind: "sell",
          pricePerUnit: "124.80",
          units: "12",
          feesMinor: 180,
        },
      ],
      ownership: HALF,
      unitSymbol: "WLDFAM",
    },
  ],
  housing: [
    {
      acquisition: { at: { yearsAgo: 5 }, valueMinor: 310_000_00 },
      annualAppreciationRate: "0.032",
      id: "asset_familia_home",
      improvements: [
        { at: { monthsAgo: 26 }, id: "asset_familia_home_reno", valueMinor: 11_500_00 },
        { at: { monthsAgo: 7 }, id: "asset_familia_home_solar", valueMinor: 8_400_00 },
      ],
      isPrimaryResidence: true,
      mortgage: {
        annualInterestRate: "0.027",
        disbursement: { monthsAgo: 60 },
        earlyRepayments: [
          {
            amountMinor: 6_000_00,
            at: { monthsAgo: 18 },
            id: "repayment_familia_mortgage_bonus",
            mode: "reduce-payment",
          },
          {
            amountMinor: 4_500_00,
            at: { monthsAgo: 4 },
            id: "repayment_familia_mortgage_term",
            mode: "reduce-term",
          },
        ],
        firstPayment: { monthsAgo: 59 },
        initialCapitalMinor: 248_000_00,
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
  liabilities: [
    {
      balanceAnchors: [
        {
          at: { monthsAgo: 18 },
          balanceMinor: 11_400_00,
          id: "liability_familia_car_anchor_0",
        },
        {
          at: { monthsAgo: 6 },
          balanceMinor: 8_200_00,
          id: "liability_familia_car_anchor_1",
        },
        {
          at: { monthsAgo: 1 },
          balanceMinor: 7_200_00,
          id: "liability_familia_car_anchor_2",
        },
      ],
      balanceMinor: 7_200_00,
      id: "liability_familia_car",
      model: "informal",
      name: "Préstamo coche",
      ownership: [{ memberId: DIEGO, shareBps: 10_000 }],
    },
  ],
  fire: [
    {
      config: {
        currentAge: 39,
        excludedAssetIds: ["asset_familia_home", "asset_familia_car"],
        expectedRealReturn: 0.045,
        monthlySpendingMinor: 3_150_00,
        safeWithdrawalRate: 0.04,
        targetRetirementAge: 60,
      },
      scopeId: "household",
    },
  ],
};
