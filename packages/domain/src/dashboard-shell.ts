import type { NetWorthSummary } from "./net-worth";
import type { LocalPersistenceStatus } from "./persistence";

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
