"use client";

/**
 * Hero movers — fills the home hero with PER-HOLDING movers: which holdings moved
 * net worth most over the selected period. Two columns: top gainers (Subieron)
 * vs top losers (Bajaron), ranked by € impact on net worth. Debt paid down counts
 * as a positive impact (green = good for you).
 *
 * Period toggle (`?mvp=`, URL state like the rest of the app): Mes (vs the prior
 * monthly close) · Año (YoY). Daily "vs anterior" is intentionally not offered —
 * it is just market noise.
 *
 * The server pre-renders BOTH periods; this island toggles client-side with
 * `pushState` (interaction-patterns §2–§3, #737).
 */

import { type MouseEvent } from "react";

import type {
  HoldingMover,
  MoversData,
  MoversDataByPeriod,
  MoversPeriod,
} from "./movers-data";
import { useUrlViewParam } from "./url-view-state";
import { MOVERS_PERIOD_VIEW_PARAM } from "./view-state";

export type { HoldingMover, MoversData, MoversPeriod };

const SIGN_HELP =
  "Cada activo cuenta por su impacto en tu patrimonio. En una deuda, amortizar " +
  "suma (verde) y endeudarte más resta (rojo).";

const SIGN_HELP_LABEL = "Ayuda sobre el signo en deudas";

function Tag({ tag }: { tag: HoldingMover["tag"] }) {
  if (!tag) return null;
  return <span className={`moversTag ${tag}`}>{tag}</span>;
}

/** Hover/focus "?" hint — explains the debt sign convention. */
function MoversHelp({ text }: { text: string }) {
  const helpId = "movers-sign-help";
  return (
    <button
      type="button"
      className="moversHelp"
      aria-label={SIGN_HELP_LABEL}
      aria-describedby={helpId}
    >
      ?
      <span className="moversHelpBubble" id={helpId}>
        {text}
      </span>
    </button>
  );
}

export interface MoversPeriodTab {
  id: MoversPeriod;
  label: string;
  /** Server-built URL for this period — the no-JS fallback and the deep-link. */
  href: string;
}

function PeriodControls({
  period,
  tabs,
  onSelect,
}: {
  period: MoversPeriod;
  tabs: readonly MoversPeriodTab[];
  onSelect: (next: MoversPeriod) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="moversControls">
      <div className="moversSeg" role="group" aria-label="Periodo">
        {tabs.map((tab) => {
          const isActive = tab.id === period;
          return (
            <a
              key={tab.id}
              aria-current={isActive ? "true" : undefined}
              className={isActive ? "active" : undefined}
              data-active={isActive}
              href={tab.href}
              onClick={onSelect(tab.id)}
            >
              {tab.label}
            </a>
          );
        })}
      </div>
    </div>
  );
}

function HoldingLine({ m }: { m: HoldingMover }) {
  return (
    <div className="moversHolding">
      <span className="moversHoldingName">
        {m.label}
        {m.isDebt ? <span className="moversTag deuda">deuda</span> : null}
        <Tag tag={m.tag} />
      </span>
      <span aria-hidden="true" className="moversLeader" />
      <b className={`moversHoldingVal ${m.sign}`}>{m.changeFmt}</b>
      <span className={`moversHoldingPct ${m.sign}`}>{m.pctFmt ?? ""}</span>
    </div>
  );
}

function SplitBody({ data }: { data: MoversData }) {
  return (
    <div className="moversSplitCols">
      <div className="moversCol">
        <h4 className="up">▲ Subieron</h4>
        {data.up.length ? (
          data.up.map((m) => <HoldingLine key={m.label} m={m} />)
        ) : (
          <p className="moversEmpty">—</p>
        )}
      </div>
      <div className="moversCol">
        <h4 className="down">▼ Bajaron</h4>
        {data.down.length ? (
          data.down.map((m) => <HoldingLine key={m.label} m={m} />)
        ) : (
          <p className="moversEmpty">—</p>
        )}
      </div>
    </div>
  );
}

export default function HeroMovers({
  dataByPeriod,
  initialPeriod,
  periodTabs,
}: {
  dataByPeriod: MoversDataByPeriod;
  initialPeriod: MoversPeriod;
  periodTabs: readonly MoversPeriodTab[];
}) {
  const [period, , select] = useUrlViewParam(MOVERS_PERIOD_VIEW_PARAM, initialPeriod);

  const data = dataByPeriod[period];
  const activeLabel = periodTabs.find((tab) => tab.id === period)?.label ?? "";

  return (
    <div className="movers">
      <div className="moversHead">
        <div className="moversTitle">
          <h3>
            Qué lo movió
            <MoversHelp text={SIGN_HELP} />
          </h3>
          <small>{data.vsLabel}</small>
        </div>
        <PeriodControls onSelect={select} period={period} tabs={periodTabs} />
      </div>
      <p aria-live="polite" className="srOnly">{`Periodo: ${activeLabel}`}</p>
      {!data.hasBase ? (
        <p className="moversEmpty">
          {period === "year"
            ? "Aún no hay un año de histórico para comparar."
            : "Aún no hay un cierre mensual anterior para comparar."}
        </p>
      ) : (
        <SplitBody data={data} />
      )}
    </div>
  );
}
