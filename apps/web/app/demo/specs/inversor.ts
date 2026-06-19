/**
 * inversor persona (PRD #297) — a markets-heavy investor: funds, shares and
 * crypto on the market rung built from ~2 years of operations, a term-locked
 * pension, a frozen connected source (a Numista precious-metals collection), and
 * a configured FIRE target with strong progress. All figures fictional and
 * deterministic.
 */
import type { OperationSpec, PersonaSpec } from "@web/demo/spec-types";

const LUCIA = "member_lucia";
const FULL = [{ memberId: LUCIA, shareBps: 10_000 }];

/** A monthly ladder of buys over `count` months, oldest first — a moving curve. */
function monthlyBuys(
  assetId: string,
  count: number,
  units: string,
  basePrice: number,
): OperationSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    at: { monthsAgo: count - i },
    id: `${assetId}_op_${i}`,
    kind: "buy" as const,
    pricePerUnit: (basePrice + i).toString(),
    units,
  }));
}

export const INVERSOR_SPEC: PersonaSpec = {
  id: "inversor",
  members: [{ id: LUCIA, name: "Lucía" }],
  mode: "individual",
  manualAssets: [
    {
      id: "asset_inversor_cash",
      liquidityTier: "cash",
      name: "Liquidez del broker",
      ownership: FULL,
      type: "cash",
      valueMinor: 12_000_00,
    },
    {
      id: "asset_inversor_pension",
      liquidityTier: "term-locked",
      name: "Plan de pensiones",
      ownership: FULL,
      type: "cash",
      valueMinor: 60_000_00,
    },
  ],
  investments: [
    {
      id: "asset_inversor_world",
      manualPricePerUnit: "108.50",
      name: "ETF MSCI World",
      operations: monthlyBuys("asset_inversor_world", 24, "4", 70),
      ownership: FULL,
      unitSymbol: "WRLD",
    },
    {
      id: "asset_inversor_tech",
      manualPricePerUnit: "240.00",
      name: "Acción tecnológica",
      operations: monthlyBuys("asset_inversor_tech", 24, "2", 150),
      ownership: FULL,
      unitSymbol: "TECH",
    },
    {
      id: "asset_inversor_crypto",
      manualPricePerUnit: "52000.00",
      name: "Bitcoin",
      operations: monthlyBuys("asset_inversor_crypto", 24, "0.01", 30000),
      ownership: FULL,
      unitSymbol: "BTC",
    },
  ],
  connectedSources: [
    {
      adapter: "numista",
      label: "Colección de monedas",
      ownership: FULL,
      syncedAt: { daysAgo: 2 },
      positions: [
        {
          kind: "coin",
          externalId: "numista-1",
          name: "Soberano de oro",
          liquidityTier: "illiquid",
          currency: "EUR",
          catalogueId: "N1234",
          issueId: null,
          grade: "AU",
          quantity: 1,
          year: 1925,
          metal: "gold",
          finenessMillis: 917,
          weightGrams: 7.99,
          purchaseDate: "2023-04-12",
          metalValueMinor: null,
          numismaticValueMinor: 45_000,
          numismaticFetchedAt: null,
          purchasePriceMinor: 38_000,
          obverseThumbUrl: null,
        },
        {
          kind: "coin",
          externalId: "numista-2",
          name: "Krugerrand 1/10 oz",
          liquidityTier: "illiquid",
          currency: "EUR",
          catalogueId: "N5678",
          issueId: null,
          grade: "UNC",
          quantity: 1,
          year: 2019,
          metal: "gold",
          finenessMillis: 916,
          weightGrams: 3.39,
          purchaseDate: "2024-01-20",
          metalValueMinor: null,
          numismaticValueMinor: 24_000,
          numismaticFetchedAt: null,
          purchasePriceMinor: 21_000,
          obverseThumbUrl: null,
        },
        {
          kind: "coin",
          externalId: "numista-3",
          name: "Onza de plata Maple Leaf",
          liquidityTier: "illiquid",
          currency: "EUR",
          catalogueId: "N9012",
          issueId: null,
          grade: "UNC",
          quantity: 3,
          year: 2022,
          metal: "silver",
          finenessMillis: 999,
          weightGrams: 31.1,
          purchaseDate: "2024-06-02",
          metalValueMinor: null,
          numismaticValueMinor: 3_200,
          numismaticFetchedAt: null,
          purchasePriceMinor: 2_900,
          obverseThumbUrl: null,
        },
      ],
    },
  ],
  fire: [
    {
      config: {
        currentAge: 41,
        expectedRealReturn: 0.05,
        monthlySpendingMinor: 1_500_00,
        safeWithdrawalRate: 0.04,
        targetRetirementAge: 55,
      },
      scopeId: "household",
    },
  ],
};
