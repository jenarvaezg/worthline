"use client";

import type { AssetType, MonthlyContributionAllocation } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { useEffect, useState } from "react";
import {
  ALLOCATION_MONTH_PARAM,
  allocationBarWidthPct,
  allocationMonthUrl,
  formatAllocationMonthLabel,
  groupAllocationByType,
  parseAllocationMonthParam,
  type SourceAllocationRow,
} from "./contribution-allocation-view";

/**
 * Monthly allocation view (#557): where the plan sends incoming capital each
 * month. The server renders every month of the window once; switching month is
 * a client toggle mirrored to ?mes= with pushState — no round-trip. Figures are
 * forecast; confirmed money from S2 reconciliation is contrasted per row.
 *
 * What MyInvestor schedules for a linked holding (#1886) is listed too, read-only
 * and marked «de MyInvestor», with no controls: it is changed in MyInvestor, and
 * without it the month's total would leave out money that is going in.
 */
export function ContributionAllocation({
  months,
  initialMonthKey,
  defaultMonthKey,
  holdings,
  currency,
  privacyMode,
  sourceMonths = {},
}: {
  months: MonthlyContributionAllocation[];
  initialMonthKey: string;
  defaultMonthKey: string;
  holdings: Record<string, { name: string; type: AssetType }>;
  currency: string;
  privacyMode: boolean;
  /** By month: what a connected source schedules, per holding (#1886). */
  sourceMonths?: Readonly<Record<string, readonly SourceAllocationRow[]>>;
}) {
  const [monthKey, setMonthKey] = useState(initialMonthKey);

  useEffect(() => {
    const syncFromUrl = () => {
      setMonthKey(
        parseAllocationMonthParam(
          new URL(window.location.href).searchParams.get(ALLOCATION_MONTH_PARAM) ??
            undefined,
          months.map((m) => m.monthKey),
          defaultMonthKey,
        ),
      );
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [months, defaultMonthKey]);

  const selectMonth = (key: string) => {
    setMonthKey(key);
    window.history.pushState(
      {},
      "",
      allocationMonthUrl(window.location.href, key, defaultMonthKey),
    );
  };

  const allocation = months.find((m) => m.monthKey === monthKey) ?? months[0];
  if (!allocation) return null;

  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const typeByHoldingId = Object.fromEntries(
    Object.entries(holdings).map(([id, holding]) => [id, holding.type]),
  );
  const monthLabel = formatAllocationMonthLabel(allocation.monthKey);
  const sourceRows = sourceMonths[allocation.monthKey] ?? [];
  const totalPlannedMinor =
    allocation.totalPlannedMinor +
    sourceRows.reduce((sum, row) => sum + row.plannedMinor, 0);
  // The split by type adds up to the same total as «Previsto»: MyInvestor's rows too.
  const typeGroups = groupAllocationByType(
    [...allocation.destinations, ...sourceRows],
    typeByHoldingId,
  );

  return (
    <section className="firePanel contributionAllocation" aria-label="Reparto mensual">
      <div className="panelHeader">
        <h3>Plan de aportaciones · Reparto mensual</h3>
        <span>a dónde va tu capital según el plan</span>
      </div>

      <div
        aria-label="Mes del reparto"
        className="contributionAllocationMonths"
        role="group"
      >
        {months.map((month) => (
          <button
            aria-pressed={month.monthKey === allocation.monthKey}
            key={month.monthKey}
            onClick={() => selectMonth(month.monthKey)}
            type="button"
          >
            {formatAllocationMonthLabel(month.monthKey)}
          </button>
        ))}
      </div>

      {allocation.occurrenceCount === 0 && sourceRows.length === 0 ? (
        <p className="muted">El plan no prevé aportaciones en {monthLabel}.</p>
      ) : (
        <>
          <div className="contributionAllocationTotal">
            <div>
              <span className="memberProfileLabel">Previsto · {monthLabel}</span>
              <strong>{fmt(totalPlannedMinor)}</strong>
            </div>
            {allocation.totalExecutedMinor > 0 ? (
              <div>
                <span className="memberProfileLabel">Confirmado</span>
                <strong>{fmt(allocation.totalExecutedMinor)}</strong>
              </div>
            ) : null}
          </div>

          <ul className="contributionAllocationList">
            {allocation.destinations.map((destination) => {
              const holding = holdings[destination.holdingId];
              const widthPct = allocationBarWidthPct(
                destination.plannedMinor,
                totalPlannedMinor,
              );
              return (
                <li className="contributionAllocationRow" key={destination.holdingId}>
                  <div className="contributionAllocationRowHead">
                    <span className="contributionAllocationName">
                      {holding?.name ?? "Destino"}
                    </span>
                    <span className="contributionAllocationAmount">
                      {destination.plannedMinor !== null
                        ? fmt(destination.plannedMinor)
                        : `${destination.plannedUnits ?? "?"} uds. · sin precio`}
                    </span>
                  </div>
                  <div aria-hidden="true" className="contributionAllocationBar">
                    <i style={{ width: `${widthPct}%` }} />
                  </div>
                  <span className="contributionAllocationMeta">
                    {destination.occurrenceCount}{" "}
                    {destination.occurrenceCount === 1 ? "aportación" : "aportaciones"}
                    {destination.closedCount > 0
                      ? ` · ${destination.closedCount} de ${destination.occurrenceCount} ${destination.closedCount === 1 ? "conciliada" : "conciliadas"}`
                      : ""}
                    {destination.executedMinor > 0
                      ? ` · confirmado ${fmt(destination.executedMinor)}`
                      : ""}
                  </span>
                </li>
              );
            })}
            {sourceRows.map((row) => (
              <li className="contributionAllocationRow" key={`source-${row.holdingId}`}>
                <div className="contributionAllocationRowHead">
                  <span className="contributionAllocationName">
                    {holdings[row.holdingId]?.name ?? "Destino"}
                  </span>
                  <span className="contributionAllocationAmount">
                    {fmt(row.plannedMinor)}
                  </span>
                </div>
                <div aria-hidden="true" className="contributionAllocationBar">
                  <i
                    style={{
                      width: `${allocationBarWidthPct(row.plannedMinor, totalPlannedMinor)}%`,
                    }}
                  />
                </div>
                <span className="contributionAllocationMeta">
                  {row.occurrenceCount}{" "}
                  {row.occurrenceCount === 1 ? "aportación" : "aportaciones"} · de
                  MyInvestor, se cambia allí
                </span>
              </li>
            ))}
          </ul>

          {typeGroups.length > 1 ? (
            <p className="contributionAllocationTypes">
              {typeGroups.map((group, index) => (
                <span key={group.type}>
                  {index > 0 ? " · " : ""}
                  {group.label} <strong>{fmt(group.plannedMinor)}</strong>
                </span>
              ))}
            </p>
          ) : null}

          {allocation.unpricedHoldingIds.length > 0 ? (
            <p className="contributionAllocationNote">
              Sin precio actual para valorar:{" "}
              {allocation.unpricedHoldingIds
                .map((id) => holdings[id]?.name ?? id)
                .join(", ")}
              . Su parte no entra en el total previsto.
            </p>
          ) : null}
        </>
      )}

      <p aria-live="polite" className="srOnly">
        Reparto de {monthLabel}
      </p>
    </section>
  );
}
