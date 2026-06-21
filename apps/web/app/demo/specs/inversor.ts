/**
 * inversor persona (PRD #297) — a markets-heavy investor: funds and shares built
 * from multi-year operations, partial sells, cash reserved for taxes, a
 * term-locked pension, a frozen Numista collection, a Binance mirror with spot
 * and earn balances, and a configured FIRE target with strong progress. All
 * figures are fictional.
 */
import type {
  BinanceHistoryMonthSpec,
  OperationSpec,
  PersonaSpec,
} from "@web/demo/spec-types";

const LUCIA = "member_lucia";
const FULL = [{ memberId: LUCIA, shareBps: 10_000 }];

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
    feesMinor: 120,
  }));
}

function binanceHistoryMonths(): BinanceHistoryMonthSpec[] {
  return Array.from({ length: 18 }, (_, i) => {
    const progress = i / 17;
    return {
      monthsAgo: 18 - i,
      balances: {
        BTC: (0.12 + 0.19 * progress).toFixed(4),
        ETH: (1.8 + 1.65 * progress).toFixed(4),
        SOL: (25 + 53 * progress).toFixed(2),
      },
      prices: {
        BTC: (42_000 + 19_000 * progress).toFixed(2),
        ETH: (2_200 + 1_150 * progress).toFixed(2),
        SOL: (70 + 72 * progress).toFixed(2),
      },
    };
  });
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
      valueMinor: 18_500_00,
    },
    {
      id: "asset_inversor_tax_reserve",
      liquidityTier: "cash",
      name: "Reserva fiscal plusvalías",
      ownership: FULL,
      type: "cash",
      valueMinor: 13_800_00,
    },
    {
      id: "asset_inversor_pension",
      liquidityTier: "term-locked",
      name: "Plan de pensiones",
      ownership: FULL,
      type: "cash",
      valueMinor: 85_000_00,
    },
    {
      id: "asset_inversor_crowdlending",
      liquidityTier: "term-locked",
      name: "Crowdlending inmobiliario",
      ownership: FULL,
      type: "manual",
      valueMinor: 22_500_00,
    },
  ],
  investments: [
    {
      id: "asset_inversor_world",
      manualPricePerUnit: "118.75",
      name: "ETF MSCI World",
      operations: [
        ...monthlyBuys("asset_inversor_world", 48, "5", 62, 0.95),
        {
          at: { monthsAgo: 9 },
          id: "asset_inversor_world_tax_harvest",
          kind: "sell",
          pricePerUnit: "103.20",
          units: "20",
          feesMinor: 250,
        },
      ],
      ownership: FULL,
      unitSymbol: "WRLD",
    },
    {
      id: "asset_inversor_emerging",
      manualPricePerUnit: "52.60",
      name: "ETF emergentes",
      operations: monthlyBuys("asset_inversor_emerging", 36, "6", 38, 0.35),
      ownership: FULL,
      unitSymbol: "EMRG",
    },
    {
      id: "asset_inversor_tech",
      manualPricePerUnit: "244.00",
      name: "Acción tecnológica concentrada",
      operations: [
        ...monthlyBuys("asset_inversor_tech", 30, "1.5", 148, 2.7),
        {
          at: { monthsAgo: 5 },
          id: "asset_inversor_tech_trim",
          kind: "sell",
          pricePerUnit: "231.50",
          units: "8",
          feesMinor: 200,
        },
      ],
      ownership: FULL,
      unitSymbol: "TECH",
    },
  ],
  connectedSources: [
    {
      adapter: "binance",
      binanceHistory: binanceHistoryMonths(),
      label: "Binance · spot y earn",
      ownership: FULL,
      syncedAt: { daysAgo: 1 },
      positions: [
        {
          kind: "token",
          externalId: "BTC:spot",
          name: "Bitcoin",
          symbol: "BTC",
          balance: "0.32",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "62000",
          imageUrl: null,
          currency: "EUR",
        },
        {
          kind: "token",
          externalId: "ETH:spot",
          name: "Ethereum",
          symbol: "ETH",
          balance: "3.5",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "3400",
          imageUrl: null,
          currency: "EUR",
        },
        {
          kind: "token",
          externalId: "SOL:spot",
          name: "Solana",
          symbol: "SOL",
          balance: "80",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "145",
          imageUrl: null,
          currency: "EUR",
        },
        {
          kind: "token",
          externalId: "ETH:earn",
          name: "Ethereum bloqueado",
          symbol: "ETH",
          balance: "1.2",
          wallet: "earn",
          liquidityTier: "term-locked",
          unitPrice: "3400",
          imageUrl: null,
          currency: "EUR",
        },
      ],
    },
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
          metalValueMinor: 52_000,
          numismaticValueMinor: 61_000,
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
          metalValueMinor: 22_500,
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
          metalValueMinor: 9_600,
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
        currentAge: 42,
        expectedRealReturn: 0.05,
        monthlySpendingMinor: 2_200_00,
        safeWithdrawalRate: 0.04,
        targetRetirementAge: 55,
      },
      scopeId: "household",
    },
  ],
};
