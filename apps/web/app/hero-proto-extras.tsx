"use client";

/**
 * PROTOTYPE — throwaway. Fills the hero "hueco" with PER-HOLDING movers: which
 * holdings moved net worth most over the selected period. Two layouts, switchable
 * via `?variant=` with a dev-only floating bar; the period and unit are real
 * in-widget toggles (URL state, like the rest of the app):
 *
 *   A — "Subieron / Bajaron": two columns, top gainers vs top losers (€).
 *   B — "Ranking":            one ranked list, with a € / % toggle (`?mvu=`).
 *
 *   Period toggle (`?mvp=`): Mes (vs cierre mensual anterior) · Año (YoY). Daily
 *   "vs anterior" was dropped — it was just market noise.
 *
 * Ranked by € impact (or % when toggled). Debt paid down = positive impact
 * (green = good for you). No tests, no abstraction — DELETE once a direction is
 * chosen and fold the winner into page.tsx near .heroStats. Hidden in prod.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export interface HoldingMover {
  label: string;
  /** "+1.234 €" / "−567 €" — € impact on net worth. */
  changeFmt: string;
  /** "+8,5 %" / "−2,6 %" or null when the holding is brand new (no base). */
  pctFmt: string | null;
  sign: "pos" | "neg" | "zero";
  /** 0–100 by |€ impact| relative to the largest mover (€ bars). */
  magnitudePct: number;
  /** 0–100 by |%| relative to the largest %-mover (% bars). */
  pctMagnitude: number;
  /** "nuevo" (added since) / "vendido" (gone since), else null. */
  tag: "nuevo" | "vendido" | null;
}

export interface HeroProtoData {
  vsLabel: string;
  /** A comparison base exists for the selected period. */
  hasBase: boolean;
  /** Top gainers, € impact desc (variant A). */
  up: HoldingMover[];
  /** Top losers, € impact asc — most negative first (variant A). */
  down: HoldingMover[];
  /** Top movers, sorted by the active unit (variant B). */
  ranked: HoldingMover[];
}

export type HeroProtoVariant = "A" | "B";
export type HeroProtoPeriod = "month" | "year";
export type HeroProtoUnit = "abs" | "pct";

const VARIANTS: HeroProtoVariant[] = ["A", "B"];
const VARIANT_NAMES: Record<HeroProtoVariant, string> = {
  A: "Subieron / Bajaron",
  B: "Ranking",
};

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
  return <span className={`protoTag ${tag}`}>{tag}</span>;
}

const SIGN_HELP =
  "Cada holding cuenta por su impacto en tu patrimonio. En una deuda, amortizar " +
  "suma (verde) y endeudarte más resta (rojo).";

/** Hover/focus "?" hint — explains the debt sign convention. */
function ProtoHelp({ text }: { text: string }) {
  return (
    <button type="button" className="protoHelp" aria-label={text}>
      ?
      <span className="protoHelpBubble" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}

function MoversControls({
  variant,
  period,
  unit,
}: {
  variant: HeroProtoVariant;
  period: HeroProtoPeriod;
  unit: HeroProtoUnit;
}) {
  const setParam = useSetParam();
  return (
    <div className="protoControls">
      <div className="protoSeg" role="group" aria-label="Periodo">
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
      {variant === "B" ? (
        <div className="protoSeg" role="group" aria-label="Unidad">
          <button
            type="button"
            data-active={unit === "abs"}
            onClick={() => setParam("mvu", "abs")}
          >
            €
          </button>
          <button
            type="button"
            data-active={unit === "pct"}
            onClick={() => setParam("mvu", "pct")}
          >
            %
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HoldingLine({ m }: { m: HoldingMover }) {
  return (
    <div className="protoHolding">
      <span className="protoHoldingName">
        {m.label}
        <Tag tag={m.tag} />
      </span>
      <b className={`protoHoldingVal ${m.sign}`}>{m.changeFmt}</b>
      <span className={`protoHoldingPct ${m.sign}`}>{m.pctFmt ?? ""}</span>
    </div>
  );
}

function SplitBody({ data }: { data: HeroProtoData }) {
  return (
    <div className="protoSplitCols">
      <div className="protoCol">
        <h4 className="up">▲ Subieron</h4>
        {data.up.length ? (
          data.up.map((m) => <HoldingLine key={m.label} m={m} />)
        ) : (
          <p className="protoEmpty">—</p>
        )}
      </div>
      <div className="protoCol">
        <h4 className="down">▼ Bajaron</h4>
        {data.down.length ? (
          data.down.map((m) => <HoldingLine key={m.label} m={m} />)
        ) : (
          <p className="protoEmpty">—</p>
        )}
      </div>
    </div>
  );
}

function RankedBody({ data, unit }: { data: HeroProtoData; unit: HeroProtoUnit }) {
  if (!data.ranked.length) {
    return <p className="protoEmpty">Sin movimientos en este periodo.</p>;
  }
  return (
    <>
      {data.ranked.map((m) => {
        const primary = unit === "pct" ? (m.pctFmt ?? "nuevo") : m.changeFmt;
        const secondary = unit === "pct" ? m.changeFmt : (m.pctFmt ?? "nuevo");
        const barPct = (unit === "pct" ? m.pctMagnitude : m.magnitudePct) / 2;
        return (
          <div className="protoMoverRow" key={m.label}>
            <span className="protoMoverLabel">
              {m.label}
              <Tag tag={m.tag} />
            </span>
            <span className="protoDiverge" aria-hidden="true">
              <i
                className={`protoDivergeFill ${m.sign}`}
                style={{ width: `${barPct}%` }}
              />
            </span>
            <b className={`protoMoverVal ${m.sign}`}>{primary}</b>
            <span className={`protoMoverPct ${m.sign}`}>{secondary}</span>
          </div>
        );
      })}
    </>
  );
}

function Switcher({ variant }: { variant: HeroProtoVariant }) {
  const setParam = useSetParam();

  function cycle(direction: 1 | -1) {
    const idx = VARIANTS.indexOf(variant);
    const next = VARIANTS[(idx + direction + VARIANTS.length) % VARIANTS.length]!;
    setParam("variant", next);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      cycle(e.key === "ArrowRight" ? 1 : -1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  return (
    <div className="protoSwitcher" role="group" aria-label="Prototipo: variante del hero">
      <button type="button" aria-label="Variante anterior" onClick={() => cycle(-1)}>
        ←
      </button>
      <span>
        {variant} — {VARIANT_NAMES[variant]}
      </span>
      <button type="button" aria-label="Variante siguiente" onClick={() => cycle(1)}>
        →
      </button>
    </div>
  );
}

export default function HeroProtoExtras({
  data,
  variant,
  period,
  unit,
}: {
  data: HeroProtoData;
  variant: HeroProtoVariant;
  period: HeroProtoPeriod;
  unit: HeroProtoUnit;
}) {
  if (process.env.NODE_ENV === "production") return null;
  const title = variant === "A" ? "Qué movió tu patrimonio" : "Top movimientos";
  return (
    <div className={`proto ${variant === "A" ? "protoMoversSplit" : "protoRanked"}`}>
      <div className="protoMoversHead">
        <div className="protoMoversTitle">
          <h3>
            {title}
            <ProtoHelp text={SIGN_HELP} />
          </h3>
          <small>{data.vsLabel}</small>
        </div>
        <MoversControls variant={variant} period={period} unit={unit} />
      </div>
      {!data.hasBase ? (
        <p className="protoEmpty">
          {period === "year"
            ? "Aún no hay un año de histórico para comparar."
            : "Aún no hay un cierre mensual anterior para comparar."}
        </p>
      ) : variant === "A" ? (
        <SplitBody data={data} />
      ) : (
        <RankedBody data={data} unit={unit} />
      )}
      <Switcher variant={variant} />
    </div>
  );
}
