"use client";

/**
 * PROTOTIPO #1882 — desechable. La ficha real (`HoldingFicha`, #1826) de un holding
 * enlazado con MyInvestor al que le falta el coste de un traspaso de entrada. Nada
 * escribe: guardar el coste cambia el estado en memoria y la ficha se recalcula.
 */

import type {
  FichaAction,
  FichaFigure,
  FichaTab,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import { HoldingFicha } from "@web/patrimonio/[id]/editar/_ficha/holding-ficha";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CASES,
  type CaseKey,
  eur,
  parseEuros,
  S7_VARIANTS,
  type S7VariantKey,
  SCENARIOS,
  type Scenario,
  signedEur,
} from "./ficha-model";
import styles from "./ficha-prototype.module.css";

const BASE = "/patrimonio/prototipo-1876-ficha";

type Resolution =
  | { kind: "typed"; costMinor: number }
  | { kind: "paired"; costMinor: number }
  | null;

// ── El formulario del coste, el mismo en los tres sitios ───────────────────

function CostForm({
  onResolve,
  scenario,
}: {
  onResolve: (r: Exclude<Resolution, null>) => void;
  scenario: Scenario;
}) {
  const [typing, setTyping] = useState(scenario.candidate === null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const op = scenario.pendingOp;
  const c = scenario.candidate;

  return (
    <div className={styles.costForm}>
      <p className={styles.context}>
        El <strong>{op.date}</strong> entraron <strong>{op.units} participaciones</strong>
        , que valían {eur(op.amountMinor)}. {scenario.why}
      </p>

      {c && !typing ? (
        <div className={styles.proposal}>
          <p>
            ¿Vienen del <strong>reembolso de {c.fund}</strong> del {c.date} (
            {eur(c.amountMinor)})?
          </p>
          <p className="muted">
            Si es así, su coste, <strong>{eur(c.costMinor)}</strong>, pasa a este fondo y
            ese reembolso deja de contar como una venta.
          </p>
          <span className={styles.actions}>
            <button
              onClick={() => onResolve({ costMinor: c.costMinor, kind: "paired" })}
              type="button"
            >
              Sí, vienen de ahí
            </button>
            <button
              className={styles.textControl}
              onClick={() => setTyping(true)}
              type="button"
            >
              No, vienen de otro sitio
            </button>
          </span>
        </div>
      ) : (
        <form
          className="stackForm"
          onSubmit={(event) => {
            event.preventDefault();
            const cost = parseEuros(raw);
            if (cost === null) {
              setError("Escribe el coste en euros, por ejemplo 6.200,00.");
              return;
            }
            onResolve({ costMinor: cost, kind: "typed" });
          }}
        >
          <label>
            Lo que te costaron esas {op.units} participaciones
            <input
              className={styles.money}
              inputMode="decimal"
              name="inheritedCost"
              onChange={(e) => setRaw(e.target.value)}
              placeholder="0,00 €"
              value={raw}
            />
          </label>
          {scenario.where ? <p className="muted">{scenario.where}</p> : null}
          {error ? (
            <p className="errorBand" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit">Guardar el coste</button>
          <p className="muted">
            Es lo único de este holding que escribes tú: el resto lo pone MyInvestor, y
            ponerlo al día no lo pisa.
          </p>
        </form>
      )}
    </div>
  );
}

// ── Lo que cambia según la variante ────────────────────────────────────────

function OpsTable({
  inline,
  onResolve,
  resolution,
  scenario,
}: {
  inline: boolean;
  onResolve: (r: Exclude<Resolution, null>) => void;
  resolution: Resolution;
  scenario: Scenario;
}) {
  return (
    <table className={styles.ops}>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Operación</th>
          <th className={styles.num}>Part.</th>
          <th className={styles.num}>Importe</th>
          <th className={styles.num}>Coste</th>
        </tr>
      </thead>
      <tbody>
        {scenario.ops.map((op) => (
          <tr key={op.date + op.label}>
            <td>{op.date}</td>
            <td>
              {op.label}
              {op.pending && inline && !resolution ? (
                <div className={styles.inlineForm}>
                  <CostForm onResolve={onResolve} scenario={scenario} />
                </div>
              ) : null}
            </td>
            <td className={styles.num}>{op.units}</td>
            <td className={styles.num}>{eur(op.amountMinor)}</td>
            <td className={styles.num}>
              {op.pending ? (
                resolution ? (
                  <>
                    {eur(resolution.costMinor)}
                    <span className="conexSub">
                      {resolution.kind === "paired"
                        ? "viene del reembolso"
                        : "lo pusiste tú"}
                    </span>
                  </>
                ) : (
                  <span className={styles.pending}>falta</span>
                )
              ) : (
                eur(op.amountMinor)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Montaje ────────────────────────────────────────────────────────────────

function Switcher({
  current,
  onChange,
}: {
  current: S7VariantKey;
  onChange: (n: S7VariantKey) => void;
}) {
  const index = Math.max(
    0,
    S7_VARIANTS.findIndex((v) => v.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = S7_VARIANTS[(index + step + S7_VARIANTS.length) % S7_VARIANTS.length];
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
        <span className={styles.switcherPrefix}>Prototipo #1882 · </span>
        {S7_VARIANTS[index]?.key} ({S7_VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

export default function FichaPrototype() {
  const params = useSearchParams();
  const initialVariant = (S7_VARIANTS.find((v) => v.key === params.get("s7"))?.key ??
    "A") as S7VariantKey;
  const initialCase = (CASES.find((c) => c.key === params.get("caso"))?.key ??
    "externo") as CaseKey;
  const [variant, setVariant] = useState<S7VariantKey>(initialVariant);
  const [caseKey, setCaseKey] = useState<CaseKey>(initialCase);
  const [resolution, setResolution] = useState<Resolution>(null);
  const scenario = SCENARIOS[caseKey];

  const mirror = (key: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    url.searchParams.delete("accion");
    window.history.replaceState(null, "", url);
  };
  const changeVariant = useCallback((next: S7VariantKey) => {
    setVariant(next);
    setResolution(null);
    mirror("s7", next);
  }, []);

  const resolve = (r: Exclude<Resolution, null>) => {
    setResolution(r);
    const url = new URL(window.location.href);
    url.searchParams.delete("accion");
    window.history.pushState(null, "", url);
  };

  const costMinor =
    scenario.otherCostMinor + (resolution?.costMinor ?? scenario.pendingOp.amountMinor);
  const gain = scenario.valueMinor - costMinor;
  const pendingLine = `Falta el coste del traspaso del ${scenario.pendingOp.date}`;

  const figures: FichaFigure[] = [
    {
      detail: (
        <small className="priceRefreshCaption">
          Las pone MyInvestor · al día hoy, 07:12
        </small>
      ),
      key: "units",
      label: "Participaciones",
      value: `${scenario.units} a ${scenario.priceLabel}`,
    },
    resolution
      ? {
          key: "gain",
          label: "Ganancia total",
          tone: gain >= 0 ? "pos" : "neg",
          value: `${signedEur(gain)} · ${((gain / costMinor) * 100).toFixed(1).replace(".", ",")} %`,
        }
      : variant === "B"
        ? {
            detail: (
              <small className="priceRefreshCaption">
                provisional: falta el coste de un traspaso ·{" "}
                <FichaLink href={`${BASE}?pestaña=operaciones`} tab="operaciones">
                  Ver la operación
                </FichaLink>
              </small>
            ),
            key: "gain",
            label: "Ganancia total",
            value: `${signedEur(gain)} provisional`,
          }
        : {
            detail: (
              <small className="priceRefreshCaption">
                sin coste real: falta el de un traspaso
              </small>
            ),
            key: "gain",
            label: "Ganancia total",
            value: "—",
          },
    { key: "irr", label: "Rentabilidad anual TIR", value: resolution ? "6,1 %" : "—" },
  ];

  const actions: FichaAction[] = [
    {
      content: (
        <p className="muted">
          S9: pide la contraseña si no está guardada y lee MyInvestor. Aquí no hace nada.
        </p>
      ),
      key: "poner-al-dia",
      label: "Poner al día",
      tier: "primary",
    },
    ...(variant === "A" && !resolution
      ? [
          {
            content: <CostForm onResolve={resolve} scenario={scenario} />,
            key: "coste",
            label: "Coste del traspaso",
            tier: "more" as const,
          },
        ]
      : []),
  ];

  const tabs: FichaTab[] = [
    {
      content: (
        <>
          <p className="muted">
            Las operaciones las trae MyInvestor y son de solo lectura.
          </p>
          <OpsTable
            inline={variant === "B"}
            onResolve={resolve}
            resolution={resolution}
            scenario={scenario}
          />
        </>
      ),
      count: scenario.ops.length,
      key: "operaciones",
      label: "Operaciones",
    },
    {
      content: resolution ? (
        <p>Tu dinero (TIR) y el fondo (TWR), como en cualquier ficha.</p>
      ) : (
        <p className="emptyLine">
          Sin rentabilidad que medir hasta que se sepa el coste del traspaso.
        </p>
      ),
      key: "rentabilidad",
      label: "Rentabilidad",
    },
  ];

  return (
    <div className={styles.prototype}>
      {variant === "A" && !resolution ? (
        <div aria-label="Avisos" className="warningBand" role="alert">
          <div className="warningItem">
            <span>⚠ {pendingLine}: sin él, la ganancia no se puede medir.</span>
            <FichaLink
              action="coste"
              className="btnSmall btnWarning"
              href={`${BASE}?accion=coste`}
            >
              Indicar el coste
            </FichaLink>
          </div>
        </div>
      ) : null}

      {variant === "C" && !resolution ? (
        <section aria-label="Pregunta pendiente" className={styles.question}>
          <h3 className={styles.questionHead}>{pendingLine}</h3>
          <CostForm onResolve={resolve} scenario={scenario} />
        </section>
      ) : null}

      <HoldingFicha
        actions={actions}
        basePath={BASE}
        boardHref="/patrimonio"
        errorTargets={{}}
        figures={figures}
        instrument={scenario.instrument}
        key={`${variant}-${caseKey}`}
        name={scenario.name}
        notice={
          resolution
            ? resolution.kind === "paired"
              ? "Hecho: el coste viene del reembolso y ese reembolso ya no cuenta como venta."
              : "Coste del traspaso guardado."
            : null
        }
        rows={{}}
        tabs={tabs}
        value={eur(scenario.valueMinor)}
      />

      <div className={styles.controls}>
        <strong>Prototipo #1882 · coste heredado</strong>
        <span className={styles.toggle}>
          Caso:
          {CASES.map((c) => (
            <button
              aria-pressed={caseKey === c.key}
              key={c.key}
              onClick={() => {
                setCaseKey(c.key);
                setResolution(null);
                mirror("caso", c.key);
              }}
              type="button"
            >
              {c.label}
            </button>
          ))}
        </span>
        <button onClick={() => setResolution(null)} type="button">
          Reiniciar
        </button>
      </div>

      <Switcher current={variant} onChange={changeVariant} />
    </div>
  );
}
