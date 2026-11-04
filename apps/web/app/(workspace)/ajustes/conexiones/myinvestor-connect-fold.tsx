"use client";

/**
 * The «Conectar» fold of MyInvestor in the «Sin conectar» list (#1879, design A).
 * The fold holds, in this order: username, password, the full risk notice of ADR
 * 0114 decision 1 — open, never folded — and under it the box whose label is the
 * statement it accepts, a grey line on what is kept without it, and the button.
 *
 * If MyInvestor asks for an SMS, the code takes the SAME fold instead of the form:
 * the time it expires, the code field and «Verificar», with «Empezar de nuevo» as a
 * text control. A refusal is a red band inside the fold, which stays open. Every
 * submit leaves from here and its answer comes back as state (interaction-patterns
 * §4.1); only a finished connection redirects, so the page re-renders with the row
 * in the book.
 */

import {
  cancelMyInvestorCodeAction,
  saveMyInvestorPasswordAction,
  startMyInvestorConnectAction,
  submitMyInvestorCodeAction,
} from "@web/ajustes/myinvestor-actions";
import {
  MYINVESTOR_ACCEPTANCE_TEXT,
  MYINVESTOR_RISK_TEXT,
} from "@web/ajustes/myinvestor-copy";
import {
  MYINVESTOR_IDLE,
  type MyInvestorFormState,
} from "@web/ajustes/myinvestor-form-state";
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { myInvestorCodeDeadline } from "./myinvestor-view";

/** The risk notice, whole, BEFORE the box in reading order (ADR 0114 decision 1). */
export function MyInvestorRiskCheckbox({
  checked,
  name,
  onChange,
  required,
}: {
  checked?: boolean;
  name: string;
  onChange?: (checked: boolean) => void;
  /** Where ticking it is the whole point of the form (saving on a connected row). */
  required?: boolean;
}) {
  const noticeId = useId();
  return (
    <div className="myinvestorRisk">
      <p className="myinvestorRiskText" id={noticeId}>
        {MYINVESTOR_RISK_TEXT}
      </p>
      <label className="myinvestorRiskCheck">
        <input
          aria-describedby={noticeId}
          checked={checked}
          name={name}
          onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
          required={required}
          type="checkbox"
        />
        <span>
          <strong>Guardar la contraseña.</strong> {MYINVESTOR_ACCEPTANCE_TEXT}
        </span>
      </label>
    </div>
  );
}

export default function MyInvestorConnectFold({ currentUrl }: { currentUrl: string }) {
  const [state, setState] = useState<MyInvestorFormState>(MYINVESTOR_IDLE);
  const [save, setSave] = useState(false);
  const [pending, startTransition] = useTransition();
  // After «Empezar de nuevo» the username takes the focus back: the SMS step it
  // replaced is gone from the document, and focus must not fall to the body (§8).
  const [refocusLogin, setRefocusLogin] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  // Once the person has sent something, the fold stays open whatever comes back
  // — «Empezar de nuevo» included — so the next step never folds away under them.
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    if (refocusLogin && state.step === "credentials") {
      usernameRef.current?.focus();
      setRefocusLogin(false);
    }
  }, [refocusLogin, state.step]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const current = state;
    setEngaged(true);
    startTransition(async () => {
      setState(
        current.step === "sms"
          ? await submitMyInvestorCodeAction(current, formData)
          : await startMyInvestorConnectAction(current, formData),
      );
    });
  };

  const restart = () => {
    if (state.step !== "sms") return;
    const formData = new FormData();
    formData.set("pendingId", state.pendingId);
    // The fold goes back at once; the pending step is deleted in the background,
    // OUTSIDE the submit transition so nothing announces «Conectando…» for it.
    void cancelMyInvestorCodeAction(formData).catch(() => {
      // The row expires in minutes and the daily sweep deletes it anyway.
    });
    setState(MYINVESTOR_IDLE);
    setRefocusLogin(true);
  };

  const touched = engaged || state !== MYINVESTOR_IDLE;

  return (
    <details
      suppressHydrationWarning
      className="conexConnect"
      open={touched ? true : undefined}
    >
      <summary>Conectar</summary>
      <p aria-live="polite" className="srOnly">
        {pending
          ? state.step === "sms"
            ? "Comprobando el código…"
            : "Conectando con MyInvestor…"
          : ""}
      </p>
      {state.step === "sms" ? (
        <form className="stackForm" method="post" onSubmit={onSubmit}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="pendingId" type="hidden" value={state.pendingId} />
          <p className="muted" role="status">
            MyInvestor no conoce todavía este dispositivo y te ha mandado un SMS
            {state.destination ? ` al ${state.destination}` : ""} con un código. Escríbelo
            antes de las <strong>{myInvestorCodeDeadline(state.expiresAt)}</strong>; solo
            hace falta esta vez.
          </p>
          <label>
            Código del SMS
            <input
              autoComplete="one-time-code"
              // The code field replaces the form just sent: focus lands on it (§8).
              autoFocus
              className="myinvestorCode"
              inputMode="numeric"
              name="code"
              placeholder="000000"
            />
          </label>
          {state.error ? (
            <p className="errorBand" role="alert">
              {state.error}
            </p>
          ) : null}
          <span className="myinvestorCodeActions">
            <button aria-busy={pending || undefined} disabled={pending} type="submit">
              {pending ? "Verificando…" : "Verificar"}
            </button>
            <button
              className="myinvestorRestart"
              disabled={pending}
              onClick={restart}
              type="button"
            >
              Empezar de nuevo
            </button>
          </span>
        </form>
      ) : (
        <form className="stackForm" method="post" onSubmit={onSubmit}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <label>
            Usuario (DNI o NIE)
            <input
              autoComplete="off"
              defaultValue={state.customerId ?? ""}
              key={state.customerId ?? ""}
              name="customerId"
              placeholder="El DNI o NIE con el que entras"
              ref={usernameRef}
            />
          </label>
          <label>
            Contraseña de MyInvestor
            <input
              autoComplete="off"
              name="password"
              placeholder="Tu contraseña"
              type="password"
            />
          </label>
          <MyInvestorRiskCheckbox checked={save} name="savePassword" onChange={setSave} />
          <p className="muted">
            Sin la casilla, worthline guarda solo la marca de este dispositivo y te pide
            la contraseña cada vez que pulses «Poner al día».
          </p>
          {state.error ? (
            <p className="errorBand" role="alert">
              {state.error}
            </p>
          ) : null}
          <button aria-busy={pending || undefined} disabled={pending} type="submit">
            {pending ? "Conectando…" : "Conectar MyInvestor"}
          </button>
        </form>
      )}
    </details>
  );
}

/**
 * «Guardar la contraseña» on the connected row (ADR 0114 decision 1): username,
 * password, the whole notice and the box, which is required. Its refusal — the
 * password MyInvestor rejects, or a device it no longer trusts — comes back as a
 * red band inside the fold (interaction-patterns §4.1); success redirects. Without
 * JS the form posts to the same action and the refusal redirects.
 */
export function MyInvestorSavePasswordForm({
  currentUrl,
  sourceId,
}: {
  currentUrl: string;
  sourceId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("inlineError", "1");
    setError(null);
    startTransition(async () => {
      const result = await saveMyInvestorPasswordAction(formData);
      setError(result.ok ? null : result.error);
    });
  };

  return (
    <form
      // The SAME server action, for the no-JS post: without `inlineError` it
      // redirects on every terminal, so what it resolves to is never read.
      action={
        saveMyInvestorPasswordAction as unknown as (formData: FormData) => Promise<void>
      }
      className="stackForm"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <p aria-live="polite" className="srOnly">
        {pending ? "Comprobando la contraseña con MyInvestor…" : ""}
      </p>
      <label>
        Usuario (DNI o NIE)
        <input autoComplete="off" name="customerId" />
      </label>
      <label>
        Contraseña de MyInvestor
        <input autoComplete="off" name="password" type="password" />
      </label>
      <MyInvestorRiskCheckbox name="acceptRisk" required />
      <p className="muted">
        Se comprueba con MyInvestor antes de guardarse. Este dispositivo ya está
        verificado: no llega ningún SMS.
      </p>
      {error ? (
        <p className="errorBand" role="alert">
          {error}
        </p>
      ) : null}
      <button aria-busy={pending || undefined} disabled={pending} type="submit">
        {pending ? "Comprobando…" : "Guardar la contraseña"}
      </button>
    </form>
  );
}
