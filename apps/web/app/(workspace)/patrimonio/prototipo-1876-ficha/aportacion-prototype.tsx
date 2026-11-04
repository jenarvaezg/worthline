"use client";

/**
 * PROTOTIPO #1886 — desechable. La aportación programada de MyInvestor en la ficha
 * de un plan enlazado (S11 del PRD #1876), de solo lectura, y su aviso «no ha
 * llegado». `?s11=A|B|C`. Cifras inventadas con la forma de
 * `automatic-contributions.json` (importe, recurrencia, próxima, fin, cuenta origen).
 *
 * Pregunta: ¿dónde se ve la aportación programada en la ficha?
 *   A · una cifra más en la cabecera;
 *   B · una pestaña «Aportación» con el calendario y si cada una llegó;
 *   C · dentro del libro de operaciones: una línea arriba y la próxima como fila.
 */

import type {
  FichaFigure,
  FichaTab,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import { HoldingFicha } from "@web/patrimonio/[id]/editar/_ficha/holding-ficha";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import styles from "./ficha-prototype.module.css";

const BASE = "/patrimonio/prototipo-1876-ficha";

const VARIANTS = [
  { key: "A", name: "Cifra en la cabecera" },
  { key: "B", name: "Pestaña «Aportación»" },
  { key: "C", name: "Dentro del libro de operaciones" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];

type Case = "llega" | "no-llega" | "cancelada" | "sin-contrasena";
const CASES: { key: Case; label: string }[] = [
  { key: "llega", label: "Todas llegaron" },
  { key: "no-llega", label: "La del 5 nov no llegó" },
  { key: "cancelada", label: "Cancelada en MyInvestor" },
  { key: "sin-contrasena", label: "Sin contraseña guardada" },
];

const SCHEDULE = {
  amount: "100,00 €",
  day: "el día 5 de cada mes",
  from: "Cuenta Proyectos",
  next: "5 dic 2026",
  since: "may 2023",
  until: "may 2045",
};

interface Occurrence {
  date: string;
  status: "arrived" | "missing" | "next";
  order?: string;
}

function occurrencesFor(c: Case): Occurrence[] {
  const past: Occurrence[] = [
    { date: "5 ago 2026", order: "5 ago 2026 · 100,00 €", status: "arrived" },
    { date: "5 sep 2026", order: "8 sep 2026 · 100,00 €", status: "arrived" },
    { date: "5 oct 2026", order: "6 oct 2026 · 100,00 €", status: "arrived" },
    c === "no-llega"
      ? { date: "5 nov 2026", status: "missing" }
      : { date: "5 nov 2026", order: "5 nov 2026 · 100,00 €", status: "arrived" },
  ];
  return c === "cancelada" ? past : [...past, { date: SCHEDULE.next, status: "next" }];
}

function scheduleLine(c: Case): string {
  if (c === "cancelada")
    return `Cancelada en MyInvestor el 12 nov 2026. Era de ${SCHEDULE.amount} ${SCHEDULE.day}.`;
  return `${SCHEDULE.amount} ${SCHEDULE.day}, desde ${SCHEDULE.from}. Próxima: ${SCHEDULE.next}. Hasta ${SCHEDULE.until}.`;
}

const MISSING_TEXT =
  "La aportación del 5 nov 2026 no ha llegado: MyInvestor la tenía programada (100,00 €) y no hay ninguna orden que case.";

const STATUS_LABEL: Record<Occurrence["status"], string> = {
  arrived: "llegó",
  missing: "no ha llegado",
  next: "programada",
};

function Switcher({
  current,
  onChange,
}: {
  current: VariantKey;
  onChange: (n: VariantKey) => void;
}) {
  const index = Math.max(
    0,
    VARIANTS.findIndex((v) => v.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
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
        <span className={styles.switcherPrefix}>Prototipo #1886 · </span>
        {VARIANTS[index]?.key} ({VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

const OPS = [
  { amount: "100,00 €", date: "6 oct 2026", label: "Aportación", units: "5,61" },
  { amount: "100,00 €", date: "8 sep 2026", label: "Aportación", units: "5,70" },
  { amount: "100,00 €", date: "5 ago 2026", label: "Aportación", units: "5,74" },
];

export default function AportacionPrototype() {
  const params = useSearchParams();
  const [variant, setVariant] = useState<VariantKey>(
    (VARIANTS.find((v) => v.key === params.get("s11"))?.key ?? "A") as VariantKey,
  );
  const [c, setCase] = useState<Case>("no-llega");
  const changeVariant = useCallback((next: VariantKey) => {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("s11", next);
    window.history.replaceState(null, "", url);
  }, []);

  const occ = occurrencesFor(c);
  const missing = c === "no-llega";
  const noPassword = c === "sin-contrasena";
  const ops =
    c === "no-llega"
      ? OPS
      : [
          { amount: "100,00 €", date: "5 nov 2026", label: "Aportación", units: "5,52" },
          ...OPS,
        ];

  const figures: FichaFigure[] = [
    {
      detail: (
        <small className="priceRefreshCaption">
          Las pone MyInvestor · al día hoy, 07:12
        </small>
      ),
      key: "units",
      label: "Participaciones",
      value: "812,40 a 16,51 €",
    },
    { key: "gain", label: "Ganancia total", tone: "pos", value: "+2.104,90 € · 18,6 %" },
    ...(variant === "A"
      ? [
          {
            detail: (
              <small className="priceRefreshCaption">
                {c === "cancelada"
                  ? "cancelada en MyInvestor el 12 nov 2026"
                  : `${SCHEDULE.day} · próxima ${SCHEDULE.next} · desde ${SCHEDULE.from}`}
              </small>
            ),
            key: "aportacion",
            kind: "text" as const,
            label: "Aportación programada",
            value: c === "cancelada" ? "Ninguna" : `${SCHEDULE.amount} al mes`,
          },
        ]
      : [{ key: "irr", label: "Rentabilidad anual TIR", value: "6,4 %" }]),
  ];

  const opsTable = (
    <table className={styles.ops}>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Operación</th>
          <th className={styles.num}>Part.</th>
          <th className={styles.num}>Importe</th>
        </tr>
      </thead>
      <tbody>
        {variant === "C" && c !== "cancelada" ? (
          <tr className={styles.ghostRow}>
            <td>{SCHEDULE.next}</td>
            <td>
              Aportación programada <span className="conexSub">aún no ha pasado</span>
            </td>
            <td className={styles.num}>—</td>
            <td className={styles.num}>{SCHEDULE.amount}</td>
          </tr>
        ) : null}
        {variant === "C" && missing ? (
          <tr className={styles.missingRow}>
            <td>5 nov 2026</td>
            <td>
              Aportación programada <span className={styles.pending}>no ha llegado</span>
            </td>
            <td className={styles.num}>—</td>
            <td className={styles.num}>{SCHEDULE.amount}</td>
          </tr>
        ) : null}
        {ops.map((op) => (
          <tr key={op.date}>
            <td>{op.date}</td>
            <td>{op.label}</td>
            <td className={styles.num}>{op.units}</td>
            <td className={styles.num}>{op.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const tabs: FichaTab[] = [
    {
      content: (
        <>
          {variant === "C" ? (
            <p className={styles.scheduleLine}>
              <strong>Programada en MyInvestor:</strong> {scheduleLine(c)}
            </p>
          ) : null}
          <p className="muted">
            Las operaciones las trae MyInvestor y son de solo lectura.
          </p>
          {opsTable}
        </>
      ),
      count: 27,
      key: "operaciones",
      label: "Operaciones",
    },
    ...(variant === "B"
      ? [
          {
            content: (
              <>
                <p className={styles.scheduleLine}>
                  <strong>Programada en MyInvestor:</strong> {scheduleLine(c)}
                </p>
                <p className="muted">
                  Se cambia en MyInvestor; worthline la lee al ponerse al día.{" "}
                  {noPassword
                    ? "Sin la contraseña guardada no puede avisarte de si llega."
                    : "Si una no llega a los 5 días hábiles, te avisa."}
                </p>
                <table className={styles.ops}>
                  <thead>
                    <tr>
                      <th>Programada</th>
                      <th>Orden que casa</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...occ].reverse().map((o) => (
                      <tr key={o.date}>
                        <td>{o.date}</td>
                        <td>{o.order ?? "—"}</td>
                        <td>
                          <span
                            className={
                              o.status === "missing" ? styles.pending : undefined
                            }
                          >
                            {noPassword && o.status === "missing"
                              ? "sin comprobar"
                              : STATUS_LABEL[o.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ),
            key: "aportacion",
            label: "Aportación",
          },
        ]
      : []),
    {
      content: <p>Tu dinero (TIR) y el fondo (TWR).</p>,
      key: "rentabilidad",
      label: "Rentabilidad",
    },
  ];

  return (
    <div className={styles.prototype}>
      {missing ? (
        <div aria-label="Avisos" className="warningBand" role="alert">
          <div className="warningItem">
            <span>⚠ {MISSING_TEXT}</span>
          </div>
        </div>
      ) : null}
      {/* Sin contraseña no hay aviso propio: se queda en el «sin sincronizar» de S10. */}

      <HoldingFicha
        actions={[
          {
            content: <p className="muted">Ver #1884.</p>,
            key: "poner-al-dia",
            label: "Poner al día",
            tier: "primary",
          },
        ]}
        basePath={BASE}
        boardHref="/patrimonio"
        errorTargets={{}}
        figures={figures}
        instrument="Plan de pensiones · N9001 · MyInvestor"
        key={variant}
        name="Plan Indexado Global, PP"
        notice={null}
        rows={{}}
        tabs={tabs}
        value="13.412,06 €"
      />

      <div className={styles.controls}>
        <strong>Prototipo #1886 · aportación programada</strong>
        <span className={styles.toggle}>
          Caso:
          {CASES.map((x) => (
            <button
              aria-pressed={c === x.key}
              key={x.key}
              onClick={() => setCase(x.key)}
              type="button"
            >
              {x.label}
            </button>
          ))}
        </span>
      </div>

      <Switcher current={variant} onChange={changeVariant} />
    </div>
  );
}
