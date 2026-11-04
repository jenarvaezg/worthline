"use client";

/**
 * PROTOTIPO #1884/#1885 — desechable. «Poner al día» y la salud de la conexión en la
 * ficha real (`HoldingFicha`) de un plan enlazado con MyInvestor. `?s9=A|B|C`. Nada
 * llama a MyInvestor: el mando «Resultado» decide qué contesta la pasada.
 */

import type {
  FichaAction,
  FichaFigure,
  FichaTab,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import { HoldingFicha } from "@web/patrimonio/[id]/editar/_ficha/holding-ficha";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import styles from "./ficha-prototype.module.css";
import {
  OUTCOMES,
  type Outcome,
  RESULTS,
  type Result,
  S9_VARIANTS,
  type S9VariantKey,
  SIGNAL_TEXT,
  SIGNALS,
  type Signal,
  STEPS,
} from "./sync-model";

const BASE = "/patrimonio/prototipo-1876-ficha";

type Run =
  | { phase: "idle" }
  | { phase: "waiting" }
  | { phase: "running"; step: number }
  | { phase: "done"; result: Result; resynced?: boolean };

const LOGIN_FAILS: ReadonlySet<Outcome> = new Set([
  "password_rejected",
  "sms_required",
  "rejected_no_reason",
  "network",
  "locked",
  "limit",
]);

// ── Piezas ─────────────────────────────────────────────────────────────────

function Steps({ run }: { run: Run }) {
  if (run.phase === "waiting") {
    return (
      <p className="muted">
        Ya se está poniendo al día (la pasada de las 07:10). Esperando a que termine…
      </p>
    );
  }
  if (run.phase !== "running") return null;
  return (
    <ol className={styles.steps}>
      {STEPS.map((label, index) => (
        <li
          data-state={index < run.step ? "done" : index === run.step ? "now" : "todo"}
          key={label}
        >
          {label}
          {index < run.step ? " ✓" : index === run.step ? "…" : ""}
        </li>
      ))}
    </ol>
  );
}

function PasswordAsk({ compact, onSubmit }: { compact?: boolean; onSubmit: () => void }) {
  return (
    <form
      className={compact ? styles.inlineAsk : "stackForm"}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        Contraseña de MyInvestor
        <input autoComplete="off" name="password" type="password" />
      </label>
      <button type="submit">Poner al día</button>
      {compact ? null : (
        <p className="muted">
          Se usa para esta vez y se olvida. Para que se ponga al día sola cada día,{" "}
          <Link href="/ajustes/conexiones?variante=A">
            guarda la contraseña en Conexiones
          </Link>
          .
        </p>
      )}
    </form>
  );
}

function ResultLine({
  onAction,
  result,
}: {
  onAction: (k: NonNullable<Result["action"]>["kind"]) => void;
  result: Result;
}) {
  const cls =
    result.tone === "ok"
      ? "successBand"
      : result.tone === "warn"
        ? "warningBand"
        : "errorBand";
  return (
    <div
      className={`${cls} ${styles.result}`}
      role={result.tone === "ok" ? "status" : "alert"}
    >
      <span>{result.text}</span>
      {result.blockedUntil ? (
        <span className="conexSub">«Poner al día» vuelve {result.blockedUntil}.</span>
      ) : null}
      {result.action ? (
        result.action.kind === "sms" ? (
          <Link className="btnSmall btnWarning" href="/ajustes/conexiones?variante=A">
            {result.action.label} en Conexiones →
          </Link>
        ) : (
          <button
            className="btnSmall btnWarning"
            onClick={() => onAction(result.action!.kind)}
            type="button"
          >
            {result.action.label}
          </button>
        )
      ) : null}
    </div>
  );
}

// ── Conmutador ─────────────────────────────────────────────────────────────

function Switcher({
  current,
  onChange,
}: {
  current: S9VariantKey;
  onChange: (n: S9VariantKey) => void;
}) {
  const index = Math.max(
    0,
    S9_VARIANTS.findIndex((v) => v.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = S9_VARIANTS[(index + step + S9_VARIANTS.length) % S9_VARIANTS.length];
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
        <span className={styles.switcherPrefix}>Prototipo #1884 · </span>
        {S9_VARIANTS[index]?.key} ({S9_VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (v: T) => void;
  options: readonly { key: T; label: string }[];
  value: T;
}) {
  return (
    <span className={styles.toggle}>
      {label}:
      {options.map((o) => (
        <button
          aria-pressed={value === o.key}
          key={o.key}
          onClick={() => onChange(o.key)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

// ── Montaje ────────────────────────────────────────────────────────────────

export default function SyncPrototype() {
  const params = useSearchParams();
  const [variant, setVariant] = useState<S9VariantKey>(
    (S9_VARIANTS.find((v) => v.key === params.get("s9"))?.key ?? "A") as S9VariantKey,
  );
  const [saved, setSaved] = useState(true);
  const [outcome, setOutcome] = useState<Outcome>("ok");
  const [signal, setSignal] = useState<Signal>("none");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [asking, setAsking] = useState(false);
  const [lastGood, setLastGood] = useState("hoy, 07:12");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setRun({ phase: "idle" });
    setAsking(false);
    setLastGood("hoy, 07:12");
  };

  const changeVariant = useCallback((next: S9VariantKey) => {
    setVariant(next);
    if (timer.current) clearTimeout(timer.current);
    setRun({ phase: "idle" });
    setAsking(false);
    const url = new URL(window.location.href);
    url.searchParams.set("s9", next);
    url.searchParams.delete("accion");
    window.history.replaceState(null, "", url);
  }, []);

  const finish = (result: Result, resynced = false) => {
    setRun({ phase: "done", result, resynced });
    if (result.tone === "ok" || result.text.startsWith("Las participaciones"))
      setLastGood("hoy, 12:04");
    if (result.action?.kind === "password") setSaved(false);
  };

  const step = (n: number, o: Outcome, resync: boolean) => {
    if (n === 1 && LOGIN_FAILS.has(o) && !resync) {
      finish(RESULTS[o]);
      return;
    }
    if (n >= STEPS.length) {
      if (resync) {
        finish(
          {
            text: "Resincronizado: todo el histórico leído otra vez. Ahora cuadra.",
            tone: "ok",
          },
          true,
        );
      } else {
        finish(RESULTS[o]);
      }
      return;
    }
    setRun({ phase: "running", step: n });
    timer.current = setTimeout(() => step(n + 1, o, resync), 450);
  };

  const start = (resync = false) => {
    setAsking(false);
    if (outcome === "in_progress" && !resync) {
      setRun({ phase: "waiting" });
      timer.current = setTimeout(() => finish(RESULTS.in_progress), 1400);
      return;
    }
    step(0, outcome, resync);
  };

  /** Lo que pasa al pulsar «Poner al día»: con contraseña, ya; sin ella, se pide. */
  const press = () => {
    if (run.phase === "running" || run.phase === "waiting") return;
    if (!saved) setAsking(true);
    else start();
  };

  const onAction = (kind: "resync" | "password" | "sms") => {
    if (kind === "resync") start(true);
    if (kind === "password") setAsking(true);
  };

  const busy = run.phase === "running" || run.phase === "waiting";
  const result = run.phase === "done" ? run.result : null;
  const lasting = result && result.tone !== "ok" ? result : null;
  const dailyLine = saved
    ? "Se pone al día sola cada día"
    : "Se pone al día cuando pulsas";
  const blocked = Boolean(result?.blockedUntil);

  // ── Lo que pinta cada variante ───────────────────────────────────────────
  const panelBody: ReactNode = (
    <div className={styles.costForm}>
      <p className="muted">
        Última vez al día: <strong>{lastGood}</strong>. {dailyLine}.
      </p>
      {busy ? <Steps run={run} /> : null}
      {result ? <ResultLine onAction={onAction} result={result} /> : null}
      {!busy && (asking || (!saved && run.phase === "idle")) ? (
        <PasswordAsk onSubmit={() => start()} />
      ) : null}
      {!busy && saved && !blocked && run.phase !== "done" ? (
        <button onClick={() => start()} type="button">
          Poner al día ahora
        </button>
      ) : null}
    </div>
  );

  const figureDetail: ReactNode =
    variant === "B" ? (
      <small className="priceRefreshCaption">
        {busy ? (
          run.phase === "waiting" ? (
            "Esperando a la pasada de las 07:10…"
          ) : (
            `${STEPS[(run as { step: number }).step]}… (${(run as { step: number }).step + 1}/${STEPS.length})`
          )
        ) : (
          <>
            Las pone MyInvestor · al día {lastGood} ·{" "}
            {blocked ? (
              <span>vuelve {result?.blockedUntil}</span>
            ) : (
              <button className={styles.textControl} onClick={press} type="button">
                Poner al día
              </button>
            )}
          </>
        )}
        {asking && !busy ? <PasswordAsk compact onSubmit={() => start()} /> : null}
      </small>
    ) : (
      <small className="priceRefreshCaption">
        Las pone MyInvestor · al día {lastGood}
      </small>
    );

  const figures: FichaFigure[] = [
    {
      detail: figureDetail,
      key: "units",
      label: "Participaciones",
      value: "401,77 a 18,11 €",
    },
    { key: "gain", label: "Ganancia total", tone: "pos", value: "+1.076,33 € · 17,4 %" },
    { key: "irr", label: "Rentabilidad anual TIR", value: "6,1 %" },
  ];

  const actions: FichaAction[] =
    variant === "A"
      ? [
          {
            content: panelBody,
            key: "poner-al-dia",
            label: busy ? "Poniendo al día…" : "Poner al día",
            tier: "primary",
          },
        ]
      : [];

  const tabs: FichaTab[] = [
    {
      content: (
        <p className="muted">
          Las operaciones las trae MyInvestor y son de solo lectura.
        </p>
      ),
      count: 3,
      key: "operaciones",
      label: "Operaciones",
    },
    {
      content: <p>Tu dinero (TIR) y el fondo (TWR).</p>,
      key: "rentabilidad",
      label: "Rentabilidad",
    },
  ];

  const signalLine = signal === "none" ? null : SIGNAL_TEXT[signal];

  return (
    <div className={styles.prototype}>
      {/* A y B: lo que dura (errores, señales) va en la banda de avisos de la ficha. */}
      {variant !== "C" && (lasting || signalLine) ? (
        <div aria-label="Avisos" className="warningBand" role="alert">
          {lasting ? (
            <div className="warningItem">
              <span>⚠ {lasting.text}</span>
              {lasting.action ? (
                lasting.action.kind === "sms" ? (
                  <Link
                    className="btnSmall btnWarning"
                    href="/ajustes/conexiones?variante=A"
                  >
                    {lasting.action.label} en Conexiones →
                  </Link>
                ) : (
                  <button
                    className="btnSmall btnWarning"
                    onClick={() =>
                      variant === "A" && lasting.action?.kind === "password"
                        ? press()
                        : onAction(lasting.action!.kind)
                    }
                    type="button"
                  >
                    {lasting.action.label}
                  </button>
                )
              ) : null}
            </div>
          ) : null}
          {signalLine ? (
            <div className="warningItem">
              <span>⚠ {signalLine}</span>
              <Link className="btnSmall btnWarning" href="/ajustes/conexiones">
                Ver la conexión →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* C: la franja de la conexión. En la ficha real iría sobre las pestañas. */}
      {variant === "C" ? (
        <section aria-label="Conexión con MyInvestor" className={styles.strip}>
          <div className={styles.stripTop}>
            <span>
              <strong>MyInvestor</strong> · al día {lastGood}
              <span className="conexSub">
                {dailyLine}. Pone al día todos tus productos de MyInvestor, no solo este.
              </span>
            </span>
            <span className={styles.actions}>
              {busy ? (
                <span className="muted">Poniendo al día…</span>
              ) : blocked ? (
                <span className="muted">Vuelve {result?.blockedUntil}</span>
              ) : (
                <button className="btnSecondary" onClick={press} type="button">
                  Poner al día
                </button>
              )}
              <Link className="actionLink" href="/ajustes/conexiones">
                Conexión →
              </Link>
            </span>
          </div>
          {busy ? <Steps run={run} /> : null}
          {asking && !busy ? <PasswordAsk compact onSubmit={() => start()} /> : null}
          {result ? <ResultLine onAction={onAction} result={result} /> : null}
          {signalLine ? <p className={styles.stripSignal}>⚠ {signalLine}</p> : null}
        </section>
      ) : null}

      <HoldingFicha
        actions={actions}
        basePath={BASE}
        boardHref="/patrimonio"
        errorTargets={{}}
        figures={figures}
        instrument="Plan de pensiones · N9002 · MyInvestor"
        key={variant}
        name="Plan Indexado Europa, PP"
        notice={variant !== "C" && result?.tone === "ok" ? result.text : null}
        rows={{}}
        tabs={tabs}
        value="7.276,33 €"
      />

      <div className={styles.controls}>
        <strong>Prototipo #1884 · poner al día y salud</strong>
        <Toggle
          label="Contraseña"
          onChange={(v) => setSaved(v === "si")}
          options={[
            { key: "si", label: "Guardada" },
            { key: "no", label: "No guardada" },
          ]}
          value={saved ? "si" : "no"}
        />
        <Toggle
          label="Resultado"
          onChange={setOutcome}
          options={OUTCOMES}
          value={outcome}
        />
        <Toggle
          label="Señal (S10)"
          onChange={setSignal}
          options={SIGNALS}
          value={signal}
        />
        <button onClick={reset} type="button">
          Reiniciar
        </button>
      </div>

      <Switcher current={variant} onChange={changeVariant} />
    </div>
  );
}
