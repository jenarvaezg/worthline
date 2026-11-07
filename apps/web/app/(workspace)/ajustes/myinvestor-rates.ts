/**
 * The ECB rates a MyInvestor fold converts with (#1899, ADR 0072): the days its
 * orders in another currency were placed, one request per currency over a window
 * covering them all (`resolveFxRateSnapshotForDates`). A read in euros only asks
 * nothing, so the ordinary path costs what it cost before.
 *
 * It never rejects: an ECB outage is an empty snapshot, and the fold then leaves
 * those orders out and names their day instead of inventing a rate.
 */
import type { FxRateSnapshot } from "@worthline/domain";
import { BASE_CURRENCY, isCaptureCurrency } from "@worthline/domain";
import {
  type ResolveFxRateSnapshotOptions,
  resolveFxRateSnapshotForDates,
} from "@worthline/pricing";
import type { MyInvestorDiscovery } from "./myinvestor-discovery";

export function resolveMyInvestorRates(
  discovery: MyInvestorDiscovery,
  options: ResolveFxRateSnapshotOptions = {},
): Promise<FxRateSnapshot> {
  const foreign = discovery.operations
    .map((fact) => fact.payload)
    .filter(
      (fact) => fact.currency !== BASE_CURRENCY && isCaptureCurrency(fact.currency),
    );
  return resolveFxRateSnapshotForDates(
    foreign.map((fact) => fact.currency),
    foreign.map((fact) => fact.executedAt),
    options,
  );
}
