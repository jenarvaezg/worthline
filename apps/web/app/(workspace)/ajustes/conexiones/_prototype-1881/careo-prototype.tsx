"use client";

/**
 * PROTOTIPO #1881 — desechable. El careo de S6 (`?s6=A|B|C`) dentro del pliegue que
 * decidió #1880 (D: lista por cuenta + «Así queda tu patrimonio»). Solo salen los
 * productos que importan aquí: un gemelo por ISIN, una sugerencia por nombre y uno nuevo.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type CareoRow,
  careoRows,
  counts,
  day,
  eur,
  type Mark,
  S6_VARIANTS,
  type S6VariantKey,
  sideOf,
  signedEur,
  signedUnits,
  TWINS,
  type Twin,
  units,
} from "./careo-model";
import styles from "./careo-prototype.module.css";

type Choice = "link" | "separate" | "skip";

const NEW_PRODUCT = { name: "Plan Indexado Global, PP", valueMinor: 13_412_06 };

const MARK_LABEL: Record<Mark, string> = {
  enters: "+ entra",
  leaves: "− se va",
  same: "= coincide",
};

// ── Piezas del careo ───────────────────────────────────────────────────────

function Cuadre({ twin }: { twin: Twin }) {
  const man = sideOf(twin.manual, twin.priceMinor);
  const mi = sideOf(twin.myinvestor, twin.priceMinor);
  const rows: [string, string, string, string][] = [
    [
      "Participaciones",
      units(man.units),
      units(mi.units),
      signedUnits(mi.units - man.units),
    ],
    [
      "Coste",
      eur(man.costMinor),
      eur(mi.costMinor),
      signedEur(mi.costMinor - man.costMinor),
    ],
    [
      "Coste medio",
      eur(man.avgMinor),
      eur(mi.avgMinor),
      signedEur(mi.avgMinor - man.avgMinor),
    ],
    [
      "Valor hoy",
      eur(man.valueMinor),
      eur(mi.valueMinor),
      signedEur(mi.valueMinor - man.valueMinor),
    ],
  ];
  return (
    <table className={styles.cuadre}>
      <thead>
        <tr>
          <th />
          <th className={styles.num}>A mano</th>
          <th className={styles.num}>MyInvestor</th>
          <th className={styles.num}>Cambio</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b, d]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className={styles.num}>{a}</td>
            <td className={styles.num}>{b}</td>
            <td className={styles.num}>{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpsTable({ rows }: { rows: CareoRow[] }) {
  return (
    <table className={styles.ops}>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Operación</th>
          <th className={styles.num}>Importe</th>
          <th className={styles.num}>Part.</th>
          <th>Al enlazar</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            data-mark={row.mark}
            key={`${row.mark}-${row.op.date}-${row.op.amountMinor}`}
          >
            <td>{day(row.op.date)}</td>
            <td>{row.op.label}</td>
            <td className={styles.num}>{eur(row.op.amountMinor)}</td>
            <td className={styles.num}>{units(row.op.units)}</td>
            <td>
              <span className={styles.mark}>{MARK_LABEL[row.mark]}</span>
              {row.near ? (
                <span className="conexSub">
                  igual que la del {day(row.near)}: revisa la fecha
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanLine({ twin }: { twin: Twin }) {
  if (!twin.plan) return null;
  return (
    <p className={styles.planLine}>
      Tu plan de aportación «{twin.plan.line}» se cierra hoy: lo enlazado lo trae
      MyInvestor. Se
      {twin.plan.pending.length === 1
        ? " borra la aportación pendiente"
        : " borran las aportaciones pendientes"}{" "}
      del {twin.plan.pending.join(", ")}.
    </p>
  );
}

function Verdict({ twin }: { twin: Twin }) {
  const rows = careoRows(twin);
  const c = counts(rows);
  const man = sideOf(twin.manual, twin.priceMinor);
  const mi = sideOf(twin.myinvestor, twin.priceMinor);
  return (
    <p className={styles.verdict}>
      Coinciden <strong>{c.same}</strong> de {twin.manual.length} operaciones tuyas.{" "}
      {c.leaves > 0
        ? `Se ${c.leaves === 1 ? "va 1 tuya" : `van ${c.leaves} tuyas`}`
        : "No se va ninguna"}{" "}
      y{" "}
      {c.enters > 0
        ? `entra${c.enters === 1 ? " 1" : `n ${c.enters}`} de MyInvestor`
        : "no entra ninguna"}
      . Participaciones {units(man.units)} → <strong>{units(mi.units)}</strong>; coste{" "}
      {eur(man.costMinor)} → <strong>{eur(mi.costMinor)}</strong>; coste medio{" "}
      {eur(man.avgMinor)} → <strong>{eur(mi.avgMinor)}</strong>.
      {twin.plan ? ` Tu plan de ${twin.plan.line} se cierra hoy.` : ""}
    </p>
  );
}

// ── La elección por gemelo ─────────────────────────────────────────────────

function ChoiceRadios({
  choice,
  onChange,
  twin,
}: {
  choice: Choice;
  onChange: (c: Choice) => void;
  twin: Twin;
}) {
  const opts: [Choice, string][] = [
    ["link", `Enlazar con «${twin.manualName}»: MyInvestor sustituye sus operaciones`],
    ["separate", "Crear aparte: contaría dos veces si es el mismo"],
    ["skip", "No incluir"],
  ];
  return (
    <fieldset className={styles.choice}>
      <legend className="conexSub">
        {twin.match === "strong"
          ? `Ya lo tienes a mano con el mismo ISIN en «${twin.manualName}».`
          : `Se parece por el nombre a «${twin.manualName}», que no tiene ISIN. ¿Es el mismo?`}
      </legend>
      {opts.map(([key, label]) => (
        <label key={key}>
          <input
            checked={choice === key}
            name={`choice-${twin.id}`}
            onChange={() => onChange(key)}
            type="radio"
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function TwinHeader({ twin }: { twin: Twin }) {
  const mi = sideOf(twin.myinvestor, twin.priceMinor);
  return (
    <div className={styles.productHead}>
      <span>
        <span className={styles.productName}>{twin.name}</span>
        <span className="conexSub">
          Fondo · <span className={styles.code}>{twin.code}</span> ·{" "}
          {twin.myinvestor.length} operaciones
        </span>
      </span>
      <span className={styles.num}>
        {eur(mi.valueMinor)}
        <span className="conexSub">{units(mi.units)} part.</span>
      </span>
    </div>
  );
}

// ── La cesta ───────────────────────────────────────────────────────────────

function Basket({
  choices,
  cta,
  onSubmit,
}: {
  choices: Record<string, Choice>;
  cta: string;
  onSubmit: () => void;
}) {
  let delta = NEW_PRODUCT.valueMinor;
  let created = 1;
  let linked = 0;
  let plans = 0;
  for (const twin of TWINS) {
    const choice = choices[twin.id];
    const mi = sideOf(twin.myinvestor, twin.priceMinor);
    const man = sideOf(twin.manual, twin.priceMinor);
    if (choice === "link") {
      linked += 1;
      delta += mi.valueMinor - man.valueMinor;
      if (twin.plan) plans += 1;
    }
    if (choice === "separate") {
      created += 1;
      delta += mi.valueMinor;
    }
  }
  return (
    <aside className={styles.basket}>
      <h3 className={styles.basketHead}>Así queda tu patrimonio</h3>
      <dl className={styles.ledger}>
        <div>
          <dt>Nuevos ({created})</dt>
          <dd>{created} holdings</dd>
        </div>
        <div>
          <dt>Enlazados ({linked})</dt>
          <dd>{linked > 0 ? "sustituyen sus operaciones" : "—"}</dd>
        </div>
        <div className={styles.ledgerTotal}>
          <dt>Al patrimonio</dt>
          <dd>{signedEur(delta)}</dd>
        </div>
      </dl>
      <p className="muted">
        Un enlace solo suma la diferencia con lo que ya tenías a mano, no el valor entero.
      </p>
      {plans > 0 ? (
        <p className={styles.basketNote}>{plans} plan de aportación se cierra hoy.</p>
      ) : null}
      <button onClick={onSubmit} type="button">
        {cta}
      </button>
    </aside>
  );
}

// ── Variantes ──────────────────────────────────────────────────────────────

interface VariantProps {
  choices: Record<string, Choice>;
  setChoice: (id: string, c: Choice) => void;
  onDone: () => void;
}

function NewProductLine() {
  return (
    <div className={styles.product}>
      <div className={styles.productHead}>
        <span>
          <span className={styles.productName}>{NEW_PRODUCT.name}</span>
          <span className="conexSub">Plan de pensiones · N9001 · nuevo en worthline</span>
        </span>
        <span className={styles.num}>{eur(NEW_PRODUCT.valueMinor)}</span>
      </div>
    </div>
  );
}

function VariantA({ choices, setChoice, onDone }: VariantProps) {
  return (
    <div className={styles.grid}>
      <div>
        {TWINS.map((twin) => (
          <div className={styles.product} key={twin.id}>
            <TwinHeader twin={twin} />
            <ChoiceRadios
              choice={choices[twin.id]!}
              onChange={(c) => setChoice(twin.id, c)}
              twin={twin}
            />
            {choices[twin.id] === "link" ? (
              <div className={styles.careo}>
                <Cuadre twin={twin} />
                <OpsTable rows={careoRows(twin)} />
                <PlanLine twin={twin} />
              </div>
            ) : null}
          </div>
        ))}
        <NewProductLine />
      </div>
      <Basket choices={choices} cta="Incluir y enlazar" onSubmit={onDone} />
    </div>
  );
}

/** B: los dos libros enfrentados, alineados por la operación que coincide. */
function FacingLedgers({ twin }: { twin: Twin }) {
  const rows = careoRows(twin);
  return (
    <table className={styles.facing}>
      <thead>
        <tr>
          <th colSpan={3}>A mano · {twin.manualName}</th>
          <th className={styles.gutter} />
          <th colSpan={3}>MyInvestor</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const left = row.mark !== "enters";
          const right = row.mark !== "leaves";
          const cells = (on: boolean) =>
            on ? (
              <>
                <td>{day(row.op.date)}</td>
                <td className={styles.num}>{eur(row.op.amountMinor)}</td>
                <td className={styles.num}>{units(row.op.units)}</td>
              </>
            ) : (
              <td className={styles.empty} colSpan={3} />
            );
          return (
            <tr
              data-mark={row.mark}
              key={`${row.mark}-${row.op.date}-${row.op.amountMinor}`}
            >
              {cells(left)}
              <td className={styles.gutter}>
                {row.mark === "same" ? "=" : left ? "−" : "+"}
              </td>
              {cells(right)}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function VariantB({ choices, setChoice, onDone }: VariantProps) {
  const [stage, setStage] = useState<"list" | number>("list");
  const linking = TWINS.filter((t) => choices[t.id] === "link");

  if (stage === "list") {
    return (
      <div className={styles.grid}>
        <div>
          {TWINS.map((twin) => (
            <div className={styles.product} key={twin.id}>
              <TwinHeader twin={twin} />
              <ChoiceRadios
                choice={choices[twin.id]!}
                onChange={(c) => setChoice(twin.id, c)}
                twin={twin}
              />
              {choices[twin.id] === "link" ? (
                <p className="conexSub">
                  Antes de enlazar verás qué cambia, operación a operación.
                </p>
              ) : null}
            </div>
          ))}
          <NewProductLine />
        </div>
        <Basket
          choices={choices}
          cta={linking.length > 0 ? `Revisar ${linking.length} y continuar` : "Incluir"}
          onSubmit={() => (linking.length > 0 ? setStage(0) : onDone())}
        />
      </div>
    );
  }

  const twin = linking[stage]!;
  const c = counts(careoRows(twin));
  return (
    <div className={styles.step}>
      <p className={styles.stepHead}>
        Antes de enlazar · {stage + 1} de {linking.length}
      </p>
      <h3 className={styles.stepTitle}>
        {twin.name} <span className="conexSub">con «{twin.manualName}»</span>
      </h3>
      <p className="muted">
        {c.same} coinciden · {c.leaves} tuyas se van · {c.enters} de MyInvestor entran
      </p>
      <FacingLedgers twin={twin} />
      <Cuadre twin={twin} />
      <PlanLine twin={twin} />
      <span className={styles.stepActions}>
        <button
          onClick={() => (stage + 1 < linking.length ? setStage(stage + 1) : onDone())}
          type="button"
        >
          Enlazar y sustituir
        </button>
        <button
          className="btnSecondary"
          onClick={() => {
            setChoice(twin.id, "skip");
            if (stage + 1 >= linking.length) onDone();
          }}
          type="button"
        >
          No enlazar este
        </button>
        <button
          className={styles.textControl}
          onClick={() => setStage("list")}
          type="button"
        >
          ← Volver a la lista
        </button>
      </span>
    </div>
  );
}

function VariantC({ choices, setChoice, onDone }: VariantProps) {
  return (
    <div className={styles.grid}>
      <div>
        {TWINS.map((twin) => (
          <div className={styles.product} key={twin.id}>
            <TwinHeader twin={twin} />
            <ChoiceRadios
              choice={choices[twin.id]!}
              onChange={(c) => setChoice(twin.id, c)}
              twin={twin}
            />
            {choices[twin.id] === "link" ? (
              <div className={styles.careo}>
                <Verdict twin={twin} />
                <details className="conexCredentials">
                  <summary>Ver las {careoRows(twin).length} operaciones</summary>
                  <OpsTable rows={careoRows(twin)} />
                </details>
              </div>
            ) : null}
          </div>
        ))}
        <NewProductLine />
      </div>
      <Basket choices={choices} cta="Incluir y enlazar" onSubmit={onDone} />
    </div>
  );
}

// ── Conmutador y montaje ───────────────────────────────────────────────────

function Switcher({
  current,
  onChange,
}: {
  current: S6VariantKey;
  onChange: (n: S6VariantKey) => void;
}) {
  const index = Math.max(
    0,
    S6_VARIANTS.findIndex((v) => v.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = S6_VARIANTS[(index + step + S6_VARIANTS.length) % S6_VARIANTS.length];
      if (next) onChange(next.key);
    },
    [index, onChange],
  );
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);
  return (
    <div aria-label="Variantes del prototipo" className={styles.switcher} role="group">
      <button aria-label="Variante anterior" onClick={() => cycle(-1)} type="button">
        ←
      </button>
      <span>
        <span className={styles.switcherPrefix}>Prototipo #1881 · </span>
        {S6_VARIANTS[index]?.key} ({S6_VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

const INITIAL: Record<string, Choice> = { t1: "link", t2: "separate" };

export default function CareoPrototype({
  initialVariant,
}: {
  initialVariant: S6VariantKey;
}) {
  const [variant, setVariant] = useState<S6VariantKey>(initialVariant);
  const [choices, setChoices] = useState<Record<string, Choice>>(INITIAL);
  const [done, setDone] = useState(false);
  const setChoice = useCallback(
    (id: string, c: Choice) => setChoices((p) => ({ ...p, [id]: c })),
    [],
  );
  const changeVariant = useCallback((next: S6VariantKey) => {
    setVariant(next);
    setChoices(INITIAL);
    setDone(false);
    const url = new URL(window.location.href);
    url.searchParams.set("s6", next);
    window.history.replaceState(null, "", url);
  }, []);
  const props: VariantProps = { choices, onDone: () => setDone(true), setChoice };
  const linked = TWINS.filter((t) => choices[t.id] === "link");

  return (
    <section aria-label="Prototipo #1881" className={styles.prototype}>
      <div className={styles.rowHead}>
        <span>
          <span className="conexName">MyInvestor</span>
          <span className="conexSub">Cuentas, fondos y planes</span>
        </span>
        <span className={`coinStatusPill ${done ? "" : "isPending"}`.trim()}>
          {done ? "Al día" : "Falta elegir qué incluir"}
        </span>
      </div>
      {done ? (
        <p className="successBand" role="status">
          Hecho en un solo lote.{" "}
          {linked.length > 0
            ? `${linked.map((t) => `«${t.manualName}»`).join(", ")} ya ${linked.length === 1 ? "está enlazado" : "están enlazados"}: de solo lectura, salvo el coste heredado.`
            : ""}
        </p>
      ) : (
        <details className="conexCredentials" open>
          <summary>Elegir qué incluir</summary>
          <p className="muted">
            Esto es lo que hay en tu MyInvestor (aquí solo los productos que importan para
            el careo).
          </p>
          {variant === "A" ? <VariantA {...props} /> : null}
          {variant === "B" ? <VariantB {...props} /> : null}
          {variant === "C" ? <VariantC {...props} /> : null}
        </details>
      )}
      <div className={styles.controls}>
        <strong>Prototipo #1881 · careo antes de enlazar</strong>
        <button
          onClick={() => {
            setChoices(INITIAL);
            setDone(false);
          }}
          type="button"
        >
          Reiniciar
        </button>
      </div>
      <Switcher current={variant} onChange={changeVariant} />
    </section>
  );
}
