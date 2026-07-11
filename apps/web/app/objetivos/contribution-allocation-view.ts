/**
 * Pure interaction logic for the monthly allocation view (#557), per
 * interaction-patterns §7: the island is a thin shell; the month window,
 * URL mirroring and grouping live here with their own tests.
 */

import type { AssetType, MonthlyAllocationDestination } from "@worthline/domain";
import { isContributionMonthKey } from "@worthline/domain";

export const ALLOCATION_MONTH_PARAM = "mes";

function shiftMonthKey(todayISO: string, offset: number): string {
  const [year, month] = todayISO.slice(0, 7).split("-").map(Number);
  const total = (year ?? 1970) * 12 + ((month ?? 1) - 1) + offset;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** The selectable window: previous month (contrast), current, and two forward. */
export function allocationMonthKeys(todayISO: string): string[] {
  return [-1, 0, 1, 2].map((offset) => shiftMonthKey(todayISO, offset));
}

/** Clamp a ?mes= search param to the served window; anything else falls back. */
export function parseAllocationMonthParam(
  value: string | string[] | undefined,
  monthKeys: string[],
  defaultKey: string,
): string {
  if (typeof value !== "string" || !isContributionMonthKey(value)) return defaultKey;
  return monthKeys.includes(value) ? value : defaultKey;
}

/** Mirror the selected month to the URL; the default month keeps the URL clean. */
export function allocationMonthUrl(
  href: string,
  monthKey: string,
  defaultKey: string,
): string {
  const url = new URL(href, "http://worthline.local");
  if (monthKey === defaultKey) {
    url.searchParams.delete(ALLOCATION_MONTH_PARAM);
  } else {
    url.searchParams.set(ALLOCATION_MONTH_PARAM, monthKey);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

const monthLabelFormatter = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatAllocationMonthLabel(monthKey: string): string {
  const label = monthLabelFormatter.format(new Date(`${monthKey}-01T00:00:00Z`));
  return label.replace(" de ", " ");
}

/** Share of the priced total, clamped to [0,100]; unpriced rows have no bar. */
export function allocationBarWidthPct(
  plannedMinor: number | null,
  totalPlannedMinor: number,
): number {
  if (plannedMinor === null || totalPlannedMinor <= 0) return 0;
  return Math.min(100, Math.max(0, (plannedMinor / totalPlannedMinor) * 100));
}

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  cash: "Efectivo",
  investment: "Inversión",
  real_estate: "Inmueble",
  manual: "Otros",
};

export interface AllocationTypeGroup {
  type: AssetType;
  label: string;
  plannedMinor: number;
}

/** Secondary read: the priced split by asset class, largest first. */
export function groupAllocationByType(
  destinations: Pick<MonthlyAllocationDestination, "holdingId" | "plannedMinor">[],
  typeByHoldingId: Record<string, AssetType>,
): AllocationTypeGroup[] {
  const totals = new Map<AssetType, number>();
  for (const destination of destinations) {
    if (destination.plannedMinor === null) continue;
    const type = typeByHoldingId[destination.holdingId] ?? "manual";
    totals.set(type, (totals.get(type) ?? 0) + destination.plannedMinor);
  }
  return [...totals.entries()]
    .filter(([, plannedMinor]) => plannedMinor > 0)
    .map(([type, plannedMinor]) => ({
      type,
      label: ASSET_TYPE_LABELS[type],
      plannedMinor,
    }))
    .sort((a, b) => b.plannedMinor - a.plannedMinor || a.label.localeCompare(b.label));
}
