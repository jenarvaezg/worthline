/**
 * joven persona (PRD #297) — someone just starting out: an individual workspace
 * with salary cash, an emergency buffer, a small term-locked moving fund, first
 * index-fund and employer-share operations, an education loan with declared
 * balances, no property, and FIRE left unconfigured so the onboarding checklist
 * still shows. Modest net worth. All figures are fictional.
 */
import type { OperationSpec, PersonaSpec } from "@web/demo/spec-types";

const ALEX = "member_alex";
const FULL = [{ memberId: ALEX, shareBps: 10_000 }];

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
    feesMinor: 50,
  }));
}

export const JOVEN_SPEC: PersonaSpec = {
  id: "joven",
  members: [{ id: ALEX, name: "Alex" }],
  mode: "individual",
  manualAssets: [
    {
      id: "asset_joven_checking",
      liquidityTier: "cash",
      name: "Cuenta nómina",
      ownership: FULL,
      type: "cash",
      valueMinor: 2_900_00,
    },
    {
      id: "asset_joven_savings",
      liquidityTier: "cash",
      name: "Hucha de emergencia",
      ownership: FULL,
      type: "cash",
      valueMinor: 6_200_00,
    },
    {
      id: "asset_joven_rent_deposit",
      liquidityTier: "term-locked",
      name: "Fianza y mudanza apartada",
      ownership: FULL,
      type: "cash",
      valueMinor: 1_800_00,
    },
    {
      id: "asset_joven_bike_laptop",
      liquidityTier: "illiquid",
      name: "Bici y portátil",
      ownership: FULL,
      type: "manual",
      valueMinor: 1_150_00,
    },
  ],
  investments: [
    {
      id: "asset_joven_fund",
      manualPricePerUnit: "43.20",
      name: "Primer fondo indexado global",
      operations: monthlyBuys("asset_joven_fund", 16, "3.5", 34, 0.45),
      ownership: FULL,
      unitSymbol: "IDXJ",
    },
    {
      id: "asset_joven_company_stock",
      manualPricePerUnit: "27.40",
      name: "Acciones de la empresa",
      operations: monthlyBuys("asset_joven_company_stock", 8, "4", 20, 0.8),
      ownership: FULL,
      unitSymbol: "RSU",
    },
  ],
  liabilities: [
    {
      balanceAnchors: [
        {
          at: { monthsAgo: 12 },
          balanceMinor: 6_000_00,
          id: "liability_joven_master_anchor_0",
        },
        {
          at: { monthsAgo: 4 },
          balanceMinor: 5_100_00,
          id: "liability_joven_master_anchor_1",
        },
        {
          at: { monthsAgo: 1 },
          balanceMinor: 4_600_00,
          id: "liability_joven_master_anchor_2",
        },
      ],
      balanceMinor: 4_600_00,
      id: "liability_joven_master",
      model: "informal",
      name: "Préstamo máster",
      ownership: FULL,
    },
  ],
  // No FIRE config on purpose — the onboarding "Configura FIRE" step stays pending,
  // so the dashboard keeps showing the Primeros pasos checklist.
};
