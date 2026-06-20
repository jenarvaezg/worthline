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
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface HoldingMover {
  label: string;
  /** "+1.234 €" / "−567 €" — € impact on net worth. */
  changeFmt: string;
  /** "+8,5 %" / "−2,6 %" or null when the holding is brand new (no base). */
  pctFmt: string | null;
  sign: "pos" | "neg" | "zero";
  /** "nuevo" (added since) / "vendido" (gone since), else null. */
  tag: "nuevo" | "vendido" | null;
}

export interface MoversData {
  vsLabel: string;
  /** A comparison base exists for the selected period. */
  hasBase: boolean;
  /** Top gainers, € impact desc. */
  up: HoldingMover[];
  /** Top losers, € impact asc — most negative first. */
  down: HoldingMover[];
}

export type MoversPeriod = "month" | "year";

function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
}

function Tag({ tag }: { tag: HoldingMover["tag"] }) {
  if (!tag) return null;
  return <span className={`moversTag ${tag}`}>{tag}</span>;
}

const SIGN_HELP =
  "Cada holding cuenta por su impacto en tu patrimonio. En una deuda, amortizar " +
  "suma (verde) y endeudarte más resta (rojo).";

/** Hover/focus "?" hint — explains the debt sign convention. */
function MoversHelp({ text }: { text: string }) {
  return (
    <button type="button" className="moversHelp" aria-label={text}>
      ?
      <span className="moversHelpBubble" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}

function PeriodControls({ period }: { period: MoversPeriod }) {
  const setParam = useSetParam();
  return (
    <div className="moversControls">
      <div className="moversSeg" role="group" aria-label="Periodo">
        <button
          type="button"
          data-active={period === "month"}
          onClick={() => setParam("mvp", "month")}
        >
          Mes
        </button>
        <button
          type="button"
          data-active={period === "year"}
          onClick={() => setParam("mvp", "year")}
        >
          Año
        </button>
      </div>
    </div>
  );
}

function HoldingLine({ m }: { m: HoldingMover }) {
  return (
    <div className="moversHolding">
      <span className="moversHoldingName">
        {m.label}
        <Tag tag={m.tag} />
      </span>
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
  data,
  period,
}: {
  data: MoversData;
  period: MoversPeriod;
}) {
  return (
    <div className="movers">
      <div className="moversHead">
        <div className="moversTitle">
          <h3>
            Qué movió tu patrimonio
            <MoversHelp text={SIGN_HELP} />
          </h3>
          <small>{data.vsLabel}</small>
        </div>
        <PeriodControls period={period} />
      </div>
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
