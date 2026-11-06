"use client";

/**
 * «Poner al día» of MyInvestor (#1884, design A): the panel the ficha's primary
 * action opens, and the same control in the MyInvestor row of Conexiones.
 *
 * - With the password saved, one button; without it, the username and password,
 *   used for this pass and forgotten, and the way to Conexiones to save it.
 * - While the press is pending, the steps of the pass, live (polled from
 *   `/api/myinvestor/progress`), or the wait for a pass that was already running —
 *   the press never starts a second one.
 * - The result where the steps were. What lasts (a stopped daily sync, a pause, a
 *   units mismatch) is the band's, server-rendered from the state the pass left.
 *
 * The result is computed by the server and cannot be guessed, so it is an honest
 * pending, not an optimistic one (interaction-patterns §4).
 */
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  type MyInvestorSyncFormState,
  ponerAlDiaMyInvestorAction,
} from "./myinvestor-sync-actions";
import {
  type MyInvestorProgress,
  myInvestorProgressView,
  myInvestorStepStates,
} from "./myinvestor-sync-progress";
import { formatMyInvestorHour, MYINVESTOR_RESYNC_LABEL } from "./myinvestor-sync-view";

const IDLE: MyInvestorSyncFormState = {
  blockedLine: null,
  ok: true,
  text: "",
  tone: "ok",
};

const POLL_MS = 1_000;
const CONEXIONES = "/ajustes/conexiones";

const TONE_CLASS = {
  error: "errorBand",
  ok: "successBand",
  warn: "warningBand",
} as const;

export interface MyInvestorSyncPanelProps {
  sourceId: string;
  /** Where the panel lives; the action's guard returns here. */
  currentUrl: string;
  savedPassword: boolean;
  /** «hoy, 07:12», or «Nunca». */
  lastGood: string;
  /** «Se pone al día sola cada día», «… cuando pulsas» or «… está parada». */
  dailyLine: string;
  /** The hour a pass already running started, when one is. */
  runningSince: string | null;
  /** When the button comes back, while it cannot be used. */
  blockedLine: string | null;
  /** Offer «Resincronizar todo»: some linked holding's units do not square. */
  resync: boolean;
  /** What the last pass ended in, for a panel opened after it (or reopened). */
  lastLine: string | null;
  /** A viewer, the demo, an impersonating admin: shown, not pressable. */
  readOnly: boolean;
  /** `panel`: the ficha's side panel. `row`: the row of Conexiones. */
  layout: "panel" | "row";
}

/** The last poll, with how far the server's clock is from this one's. */
interface Polled {
  progress: MyInvestorProgress;
  /** Server minus client, in ms: a pass is compared on the server's clock. */
  skewMs: number;
}

function useProgress(sourceId: string, pending: boolean): Polled | null {
  const [polled, setPolled] = useState<Polled | null>(null);
  useEffect(() => {
    if (!pending) {
      setPolled(null);
      return;
    }
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/myinvestor/progress?sourceId=${encodeURIComponent(sourceId)}`,
          { cache: "no-store" },
        );
        if (!live || !response.ok) return;
        const progress = (await response.json()) as MyInvestorProgress;
        setPolled({ progress, skewMs: Date.parse(progress.now) - Date.now() });
      } catch (error) {
        // A lost poll only leaves the last step on screen; the pass itself answers
        // through the action. Said in the console, never swallowed silently.
        console.warn("MyInvestor progress poll failed", error);
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, sourceId]);
  return polled;
}

function Steps({ current, compact }: { current: number; compact: boolean }) {
  const states = myInvestorStepStates(current);
  if (compact) {
    const now = states[current];
    return (
      <p aria-live="polite" className="conexSub">
        {now?.label}… ({current + 1}/{states.length})
      </p>
    );
  }
  return (
    <ol aria-live="polite" className="myinvestorSyncSteps">
      {states.map((step) => (
        <li data-state={step.state} key={step.key}>
          {step.label}
          {step.state === "done" ? " ✓" : step.state === "now" ? "…" : ""}
        </li>
      ))}
    </ol>
  );
}

export default function MyInvestorSyncPanel(props: MyInvestorSyncPanelProps) {
  const { layout, sourceId } = props;
  const [state, action, pending] = useActionState(ponerAlDiaMyInvestorAction, IDLE);
  const [pressedAt, setPressedAt] = useState(0);
  const polled = useProgress(sourceId, pending);
  const view = pending
    ? myInvestorProgressView(polled?.progress ?? null, pressedAt, polled?.skewMs ?? 0)
    : null;
  const compact = layout === "row";

  // A result belongs to the visit that pressed: when the route is hidden
  // (`<Activity>` keeps its state) or the panel unmounts, the effect's cleanup
  // marks it seen, so coming back shows the server's reading, not a stale line.
  const [seen, setSeen] = useState<MyInvestorSyncFormState>(IDLE);
  useEffect(() => () => setSeen(state), [state]);
  const fresh = state !== seen && state !== IDLE;

  const result = fresh && state.ok && state.text ? state : null;
  const refusal = fresh && !state.ok ? state.error : null;

  // The result takes the place of the button that had the focus: it gets the
  // focus, so the keyboard is not dropped back at the top of the page (§8).
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state !== IDLE) outcomeRef.current?.focus();
  }, [state]);
  const blockedLine = result?.blockedLine ?? props.blockedLine;
  const asksPassword = !props.savedPassword;

  const fields = asksPassword ? (
    <>
      <label>
        Usuario (DNI o NIE)
        <input autoComplete="off" name="customerId" required type="text" />
      </label>
      <label>
        Contraseña de MyInvestor
        <input autoComplete="off" name="password" required type="password" />
      </label>
    </>
  ) : null;

  const form = (
    <form
      action={action}
      className={compact ? "myinvestorSyncInline" : "stackForm"}
      onSubmit={() => setPressedAt(Date.now())}
    >
      <input name="currentUrl" type="hidden" value={props.currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      {fields}
      <span className="myinvestorSyncButtons">
        <button disabled={pending || props.readOnly} type="submit">
          {pending
            ? "Poniendo al día…"
            : props.savedPassword && !compact
              ? "Poner al día ahora"
              : "Poner al día"}
        </button>
        {props.resync ? (
          <button
            className="btnSecondary"
            disabled={pending || props.readOnly}
            name="fullHistory"
            type="submit"
            value="1"
          >
            {MYINVESTOR_RESYNC_LABEL}
          </button>
        ) : null}
      </span>
      {asksPassword && !compact ? (
        <p className="muted">
          Se usa para esta vez y se olvida. Para que se ponga al día sola cada día,{" "}
          <Link href={CONEXIONES}>guarda la contraseña en Conexiones</Link>.
        </p>
      ) : null}
    </form>
  );

  const progressLine = view ? (
    view.kind === "waiting" ? (
      <p aria-live="polite" className={compact ? "conexSub" : "muted"}>
        Ya se está poniendo al día (la pasada de las{" "}
        {formatMyInvestorHour(view.startedAt)}). Esperando a que termine…
      </p>
    ) : (
      <Steps compact={compact} current={view.current} />
    )
  ) : null;

  const outcome = result ? (
    <p
      className={`${TONE_CLASS[result.tone]} myinvestorSyncResult`}
      ref={outcomeRef}
      role={result.tone === "ok" ? "status" : "alert"}
      tabIndex={-1}
    >
      {result.text}
    </p>
  ) : refusal ? (
    <p
      className="errorBand myinvestorSyncResult"
      ref={outcomeRef}
      role="alert"
      tabIndex={-1}
    >
      {refusal}
    </p>
  ) : null;

  const control =
    blockedLine && !pending ? (
      <p className={compact ? "conexSub" : "muted"}>{blockedLine}</p>
    ) : compact && asksPassword ? (
      <details suppressHydrationWarning className="conexCredentials myinvestorSyncAsk">
        <summary>Poner al día</summary>
        {form}
      </details>
    ) : (
      form
    );

  if (compact) {
    return (
      <div className="myinvestorSyncRow">
        {control}
        {progressLine}
        {outcome}
      </div>
    );
  }

  return (
    <div className="myinvestorSync">
      <p className="muted">
        Última vez al día: <strong>{props.lastGood}</strong>. {props.dailyLine}. Pone al
        día todos tus productos de MyInvestor, no solo este.
      </p>
      {props.runningSince && !pending && !result ? (
        <p className="muted">
          Ya se está poniendo al día (la pasada de las {props.runningSince}). Si pulsas,
          esperarás a que termine.
        </p>
      ) : null}
      {props.lastLine && !pending && !outcome ? (
        <p className="muted">Última pasada: {props.lastLine}</p>
      ) : null}
      {progressLine}
      {outcome}
      {control}
    </div>
  );
}
