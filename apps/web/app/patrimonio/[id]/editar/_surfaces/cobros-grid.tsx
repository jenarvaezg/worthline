"use client";

/**
 * The interactive "Cobros" grid island (PRD #652 S1, #656; folded from S0 variant
 * C2). RSC-first (ADR 0036): the server section computes the rows and renders the
 * primary forms; this island owns only the two view-toggles that must not reload —
 * the year selector and the click→month drawer — mirroring the year to the URL via
 * `history.replaceState`. The heatmap is non-saturating (colour = a month above the
 * normal, not absolute size) so a flat rent stays calm; each cell splits recurrent
 * (hatched) from one-off (blue). The drawer's per-occurrence controls are server
 * actions passed down as props (exclude a derived month, delete a one-off).
 */

import type { CurrencyCode } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { useState } from "react";

import {
  availableYears,
  type CobroRow,
  heatAlpha,
  rowsByMonth,
  sumMinor,
} from "./cobros-view";

type FormAction = (formData: FormData) => void | Promise<void>;

const MONTH_ABBR = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");

const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthFormatter = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const formatDay = (iso: string) => dayFormatter.format(new Date(`${iso}T00:00:00Z`));
const formatMonth = (monthKey: string) =>
  monthFormatter.format(new Date(`${monthKey}-01T00:00:00Z`));

export function CobrosGrid({
  currency,
  currentUrl,
  deletePayoutAction,
  privacyMode,
  rows,
  today,
  updatePayoutScheduleAction,
}: {
  currency: CurrencyCode;
  currentUrl: string;
  deletePayoutAction: FormAction;
  privacyMode: boolean;
  rows: CobroRow[];
  today: string;
  updatePayoutScheduleAction: FormAction;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const years = availableYears(rows, today);
  const byMonth = rowsByMonth(rows);

  const [year, setYear] = useState(currentYear);
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const monthKeys = MONTH_ABBR.map((_, index) => `${year}-${pad2(index + 1)}`);
  // Normalise within the selected year so a flat rent-only year reads calm.
  const yearTotals = monthKeys
    .map((monthKey) => sumMinor(byMonth.get(monthKey) ?? []))
    .filter((total) => total > 0);
  const minMonth = yearTotals.length ? Math.min(...yearTotals) : 0;
  const maxMonth = yearTotals.length ? Math.max(...yearTotals) : 1;

  const selectYear = (next: number) => {
    setYear(next);
    setOpenMonth(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("cobrosYear", String(next));
      window.history.replaceState(null, "", url);
    }
  };

  const openRows = openMonth ? (byMonth.get(openMonth) ?? []) : [];

  return (
    <div className="cobrosGrid">
      <div className="cobrosYearBar">
        <div className="cobrosSegmented" role="group" aria-label="Año">
          {years.map((option) => (
            <button
              aria-pressed={option === year}
              key={option}
              onClick={() => selectYear(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
        <div className="cobrosLegend">
          <span>
            <i className="cobrosSwatchDerived" /> recurrente
          </span>
          <span>
            <i className="cobrosSwatchOneoff" /> puntual
          </span>
        </div>
      </div>

      <div className="cobrosCells">
        {monthKeys.map((monthKey, index) => {
          const monthNumber = index + 1;
          const future =
            year > currentYear || (year === currentYear && monthNumber > currentMonth);
          const monthRows = byMonth.get(monthKey) ?? [];
          const total = sumMinor(monthRows);
          const derived = sumMinor(monthRows.filter((row) => row.kind === "derived"));
          const oneoff = total - derived;

          if (future) {
            return (
              <div className="cobrosCell cobrosCellFuture" key={monthKey}>
                <div className="cobrosCellMonth">{MONTH_ABBR[index]}</div>
                <div className="cobrosCellPct">aún no</div>
              </div>
            );
          }

          const alpha = heatAlpha(total, minMonth, maxMonth);
          return (
            <button
              className="cobrosCell"
              key={monthKey}
              onClick={() => setOpenMonth(openMonth === monthKey ? null : monthKey)}
              style={
                alpha > 0 ? { background: `rgba(34, 138, 99, ${alpha})` } : undefined
              }
              type="button"
            >
              <div className="cobrosCellMonth">{MONTH_ABBR[index]}</div>
              <div
                className={`cobrosCellAmt ${total === 0 ? "cobrosCellEmpty" : ""}`.trim()}
              >
                {total === 0 ? "—" : fmt(total)}
              </div>
              {total > 0 ? (
                <div
                  className="cobrosSplitBar"
                  title={`recurrente ${fmt(derived)} · puntual ${fmt(oneoff)}`}
                >
                  {derived > 0 ? (
                    <span
                      className="cobrosSplitDerived"
                      style={{ width: `${(derived / total) * 100}%` }}
                    />
                  ) : null}
                  {oneoff > 0 ? (
                    <span
                      className="cobrosSplitOneoff"
                      style={{ width: `${(oneoff / total) * 100}%` }}
                    />
                  ) : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {openMonth ? (
        <div className="cobrosDrawer">
          <div className="cobrosDrawerHead">
            <strong>{formatMonth(openMonth)}</strong>
            <span className="cobrosCap">
              {openRows.length} {openRows.length === 1 ? "cobro" : "cobros"}
            </span>
          </div>
          <div className="cobrosRowList">
            {openRows.map((row) => (
              <div className="cobrosRow" key={row.key}>
                <span className="cobrosRowDate">{formatDay(row.dateISO)}</span>
                <span className="cobrosRowMeta">
                  {row.kind === "oneoff" ? (
                    <span className="cobrosBadge cobrosBadgeOneoff">● Puntual</span>
                  ) : (
                    <span className="cobrosBadge cobrosBadgeDerived">◇ {row.label}</span>
                  )}
                </span>
                <span className="cobrosRowAmount">{fmt(row.amountMinor)}</span>
                {row.kind === "derived" && row.scheduleId ? (
                  <form action={updatePayoutScheduleAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="scheduleId" type="hidden" value={row.scheduleId} />
                    <input name="excludeDate" type="hidden" value={row.dateISO} />
                    <button className="cobrosLinkBtn" type="submit">
                      excluir
                    </button>
                  </form>
                ) : (
                  <form action={deletePayoutAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input
                      name="payoutId"
                      type="hidden"
                      value={row.key.slice("oneoff:".length)}
                    />
                    <button className="cobrosLinkBtn" type="submit">
                      eliminar
                    </button>
                  </form>
                )}
              </div>
            ))}
            {openRows.length === 0 ? (
              <p className="cobrosCap">Sin cobros este mes.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
