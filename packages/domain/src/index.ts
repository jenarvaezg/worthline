import type { LocalPersistenceStatus, MoneyMinor } from "@worthline/contracts";

export type DashboardMetricId =
  | "total-net-worth"
  | "liquid-net-worth"
  | "housing-equity"
  | "gross-assets"
  | "debts";

export interface DashboardMetric {
  id: DashboardMetricId;
  label: string;
  value: MoneyMinor;
  posture: "neutral" | "asset" | "liability";
}

export interface DashboardModule {
  id: string;
  label: string;
  state: "empty" | "ready";
}

export interface DashboardShell {
  productName: "worthline";
  baseCurrency: "EUR";
  generatedAt: string;
  persistence: LocalPersistenceStatus;
  metrics: DashboardMetric[];
  modules: DashboardModule[];
}

export function createDashboardShell(input: {
  persistence: LocalPersistenceStatus;
}): DashboardShell {
  return {
    productName: "worthline",
    baseCurrency: "EUR",
    generatedAt: input.persistence.checkedAt,
    persistence: input.persistence,
    metrics: [
      zeroMetric("total-net-worth", "Neto total", "neutral"),
      zeroMetric("liquid-net-worth", "Neto liquido", "asset"),
      zeroMetric("housing-equity", "Vivienda neta", "asset"),
      zeroMetric("gross-assets", "Activos brutos", "asset"),
      zeroMetric("debts", "Deudas", "liability"),
    ],
    modules: [
      { id: "members", label: "Miembros", state: "empty" },
      { id: "ownership", label: "Ownership", state: "empty" },
      { id: "liquidity", label: "Piramide de liquidez", state: "empty" },
      { id: "snapshots", label: "Snapshots", state: "empty" },
      { id: "fire", label: "FIRE", state: "empty" },
    ],
  };
}

export function formatMoneyMinor(value: MoneyMinor): string {
  const formatter = new Intl.NumberFormat("es-ES", {
    currency: value.currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    style: "currency",
  });

  return formatter.format(value.amountMinor / 100);
}

function zeroMetric(
  id: DashboardMetricId,
  label: string,
  posture: DashboardMetric["posture"],
): DashboardMetric {
  return {
    id,
    label,
    posture,
    value: {
      amountMinor: 0,
      currency: "EUR",
    },
  };
}
