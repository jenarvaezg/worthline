import type { LocalPersistenceStatus } from "./persistence";
import type { NetWorthSummary } from "./net-worth";

export interface DashboardShell {
  productName: "worthline";
  baseCurrency: "EUR";
  generatedAt: string;
  persistence: LocalPersistenceStatus;
}

export function createDashboardShell(input: {
  persistence: LocalPersistenceStatus;
  summary?: NetWorthSummary;
  moduleStates?: Partial<Record<string, "empty" | "ready">>;
}): DashboardShell {
  return {
    productName: "worthline",
    baseCurrency: "EUR",
    generatedAt: input.persistence.checkedAt,
    persistence: input.persistence,
  };
}
