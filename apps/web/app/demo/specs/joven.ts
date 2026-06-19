/**
 * joven persona (PRD #297) — someone just starting out: an individual workspace
 * with most of their money in cash and one small derived investment, no property
 * and no debt, and FIRE left unconfigured so the onboarding checklist still
 * shows. Modest net worth. All figures fictional and deterministic.
 */
import type { PersonaSpec } from "@web/demo/spec-types";

const ALEX = "member_alex";

export const JOVEN_SPEC: PersonaSpec = {
  id: "joven",
  members: [{ id: ALEX, name: "Alex" }],
  mode: "individual",
  manualAssets: [
    {
      id: "asset_joven_checking",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: [{ memberId: ALEX, shareBps: 10_000 }],
      type: "cash",
      valueMinor: 6_500_00,
    },
    {
      id: "asset_joven_savings",
      liquidityTier: "cash",
      name: "Hucha de emergencia",
      ownership: [{ memberId: ALEX, shareBps: 10_000 }],
      type: "cash",
      valueMinor: 3_200_00,
    },
  ],
  investments: [
    {
      id: "asset_joven_fund",
      manualPricePerUnit: "42.80",
      name: "Mi primer fondo indexado",
      operations: Array.from({ length: 8 }, (_, i) => ({
        at: { monthsAgo: 8 - i },
        id: `asset_joven_fund_op_${i}`,
        kind: "buy" as const,
        pricePerUnit: (38 + i).toString(),
        units: "1",
      })),
      ownership: [{ memberId: ALEX, shareBps: 10_000 }],
      unitSymbol: "IDX",
    },
  ],
  // No FIRE config on purpose — the onboarding "Configura FIRE" step stays pending,
  // so the dashboard keeps showing the Primeros pasos checklist.
};
