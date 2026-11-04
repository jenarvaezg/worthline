"use client";

/**
 * PROTOTIPO #1879 — desechable. Las tres variantes de «conectar MyInvestor» sobre la
 * página real de Conexiones, con `?variante=A|B|C`. Nada llama a MyInvestor ni
 * escribe: los mandos de arriba deciden qué contestaría, y la lectura de abajo dice
 * qué quedaría guardado tras cada paso.
 */

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import styles from "./connect-prototype.module.css";
import {
  ACCEPTANCE_TEXT,
  type CodeOutcome,
  DEFAULT_SCENARIO,
  type Device,
  type Flow,
  INITIAL_FLOW,
  isExpired,
  type LoginOutcome,
  PENDING_TTL_MIN,
  type Pending,
  type Plan,
  RISK_TEXT,
  type Role,
  type Scenario,
  storedStateOf,
  submitChoice,
  submitCode,
  submitCredentials,
  VARIANTS,
  type VariantKey,
} from "./prototype-model";

const clockLabel = (min: number) => {
  const total = 12 * 60 + min;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// ── Piezas compartidas ─────────────────────────────────────────────────────

/** El aviso entero, ANTES de la casilla en orden de lectura. Nunca plegado. */
function RiskCheckbox({
  checked,
  onChange,
  required,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  required?: boolean;
}) {
  return (
    <div className={styles.risk}>
      <p className={styles.riskText}>{RISK_TEXT}</p>
      <label className={styles.riskCheck}>
        <input
          checked={checked}
          name="savePassword"
          onChange={(event) => onChange(event.target.checked)}
          required={required}
          type="checkbox"
        />
        <span>
          <strong>Guardar la contraseña.</strong> {ACCEPTANCE_TEXT}
        </span>
      </label>
    </div>
  );
}

function LoginFields() {
  return (
    <>
      <label>
        Usuario (DNI o NIE)
        <input
          autoComplete="off"
          name="username"
          placeholder="El DNI o NIE con el que entras"
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
    </>
  );
}

function CodeField() {
  return (
    <label>
      Código del SMS
      <input
        autoComplete="one-time-code"
        className={styles.codeInput}
        inputMode="numeric"
        name="code"
        placeholder="000000"
      />
    </label>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="errorBand" role="alert">
      {children}
    </p>
  );
}

function SmsIntro({ pending }: { pending: Pending }) {
  return (
    <p className="muted">
      MyInvestor no conoce todavía este dispositivo y te ha mandado un SMS con un código.
      Escríbelo antes de las{" "}
      <strong>{clockLabel(pending.since + PENDING_TTL_MIN)}</strong>; solo hace falta esta
      vez.
    </p>
  );
}

/** Qué dice la fila «Sin conectar» cuando no se puede conectar. */
function gateOf(scenario: Scenario): ReactNode | null {
  if (scenario.role === "viewer") {
    return (
      <p className="muted">
        Conectar una fuente necesita permiso para editar este workspace. Pídeselo a quien
        lo administra.
      </p>
    );
  }
  if (scenario.plan === "free") {
    return (
      <p className="muted">
        Conectar MyInvestor es premium.{" "}
        <a className="actionLink" href="/premium">
          Gestionar premium
        </a>
      </p>
    );
  }
  return null;
}

function AvailableShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.availableTail}>
      <div className="conexAvailableRow">
        <span className="conexName">MyInvestor</span>
        <span className="conexSub">
          Cuentas de valores, fondos, planes de pensiones y efectivo
        </span>
        {children}
      </div>
    </div>
  );
}

/**
 * La fila ya conectada, en el libro. Igual en las tres variantes salvo el pliegue de
 * la contraseña: en A y B sirve para dejar de guardarla; en C es donde se decide.
 */
function ConnectedRow({
  flow,
  now,
  onDisconnect,
  onSavedChange,
  passwordFoldOpen,
  scenario,
}: {
  flow: Extract<Flow, { step: "connected" }>;
  now: number;
  onDisconnect: () => void;
  onSavedChange: (savedAt: number | null) => void;
  passwordFoldOpen: boolean;
  scenario: Scenario;
}) {
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = flow.savedAt !== null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (scenario.login === "password_rejected") {
      setError("MyInvestor no acepta esa contraseña. No se ha guardado.");
      return;
    }
    setError(null);
    setAccept(false);
    onSavedChange(now);
  };

  return (
    <div className="tableScroll">
      <table className="conexTable">
        <thead>
          <tr>
            <th>Fuente</th>
            <th>Estado</th>
            <th>Última sincronización</th>
            <th className="conexNum">Elementos</th>
            <th className="conexNum">Valor</th>
            <th aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="conexName">MyInvestor</span>
              <span className="conexSub">Cuentas, fondos y planes</span>
            </td>
            <td>
              <span className="coinStatusPill isPending">Falta elegir qué incluir</span>
              <span className="conexSub">
                {saved ? "Se pone al día sola cada día" : "Se pone al día cuando pulses"}
              </span>
            </td>
            <td>Nunca</td>
            <td className="conexNum">
              0<span className="conexSub">productos</span>
            </td>
            <td className="conexNum">—</td>
            <td>
              <span className="conexActions">
                <button className="btn" type="button">
                  Elegir qué incluir (S5)
                </button>
              </span>
            </td>
          </tr>
          <tr className="conexDetailRow">
            <td colSpan={6}>
              <details className="conexCredentials" open={passwordFoldOpen}>
                <summary>
                  {saved ? "Contraseña guardada" : "Ponerse al día sola cada día"}
                </summary>
                {saved ? (
                  <div className="stackForm">
                    <p className="muted">
                      Guardada desde hoy a las {clockLabel(flow.savedAt!)}. La aceptaste
                      tú. worthline la usa para poner tus datos al día cada día; nunca
                      manda un SMS.
                    </p>
                    <button
                      className="btnSecondary"
                      onClick={() => onSavedChange(null)}
                      type="button"
                    >
                      Dejar de guardarla
                    </button>
                  </div>
                ) : (
                  <form className="stackForm" onSubmit={save}>
                    <RiskCheckbox checked={accept} onChange={setAccept} required />
                    <label>
                      Contraseña de MyInvestor
                      <input autoComplete="off" name="password" type="password" />
                    </label>
                    <p className="muted">
                      Se comprueba con MyInvestor antes de guardarse. Este dispositivo ya
                      está verificado: no llega ningún SMS.
                    </p>
                    {error ? <ErrorLine>{error}</ErrorLine> : null}
                    <button disabled={!accept} type="submit">
                      Guardar la contraseña
                    </button>
                  </form>
                )}
              </details>
              <details className="conexCredentials">
                <summary>Desconectar</summary>
                <div className="stackForm">
                  <p className="muted">
                    Se borran ya las credenciales. Lo que hubieras incluido se queda como
                    manual, con sus operaciones.
                  </p>
                  <button className="btnSecondary" onClick={onDisconnect} type="button">
                    Desconectar MyInvestor
                  </button>
                </div>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface VariantProps {
  flow: Flow;
  now: number;
  scenario: Scenario;
  setFlow: (flow: Flow) => void;
  variant: VariantKey;
}

function useConnectedProps({ flow, now, scenario, setFlow }: VariantProps) {
  return {
    now,
    onDisconnect: () => setFlow(INITIAL_FLOW),
    onSavedChange: (savedAt: number | null) => {
      if (flow.step === "connected") setFlow({ ...flow, justConnected: false, savedAt });
    },
    scenario,
  };
}

// ── A · La casilla en el pliegue del login ─────────────────────────────────

function VariantA(props: VariantProps) {
  const { flow, now, scenario, setFlow } = props;
  const [save, setSave] = useState(false);
  const connected = useConnectedProps(props);

  if (flow.step === "connected") {
    return (
      <>
        {flow.justConnected ? (
          <p className="successBand" role="status">
            MyInvestor conectado. Ahora elige qué cuentas y productos incluir.
          </p>
        ) : null}
        <ConnectedRow {...connected} flow={flow} passwordFoldOpen={false} />
      </>
    );
  }

  const gate = gateOf(scenario);
  return (
    <AvailableShell>
      {gate ?? (
        <details className="conexConnect" open>
          <summary>Conectar</summary>
          {flow.step === "credentials" ? (
            <form
              className="stackForm"
              onSubmit={(event) => {
                event.preventDefault();
                setFlow(submitCredentials("A", scenario, save, now));
              }}
            >
              <LoginFields />
              <RiskCheckbox checked={save} onChange={setSave} />
              <p className="muted">
                Sin la casilla, worthline guarda solo la marca de este dispositivo y te
                pide la contraseña cada vez que pulses «Poner al día».
              </p>
              {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
              <button type="submit">Conectar MyInvestor</button>
            </form>
          ) : flow.step === "sms" ? (
            <form
              className="stackForm"
              onSubmit={(event) => {
                event.preventDefault();
                setFlow(submitCode("A", scenario, flow.pending, now));
              }}
            >
              <SmsIntro pending={flow.pending} />
              <CodeField />
              {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
              <span className={styles.inlineActions}>
                <button type="submit">Verificar</button>
                <button
                  className={styles.textControl}
                  onClick={() => setFlow(INITIAL_FLOW)}
                  type="button"
                >
                  Empezar de nuevo
                </button>
              </span>
            </form>
          ) : null}
        </details>
      )}
    </AvailableShell>
  );
}

// ── B · Página por pasos, la casilla al final ──────────────────────────────

const B_STEPS = ["Acceso", "Código del móvil", "Cómo se pone al día"] as const;

function StepRail({ current, skipSms }: { current: number; skipSms: boolean }) {
  return (
    <ol className={styles.rail}>
      {B_STEPS.map((label, index) => {
        const skipped = skipSms && index === 1;
        return (
          <li
            aria-current={index === current ? "step" : undefined}
            className={styles.railStep}
            data-done={index < current || undefined}
            data-skipped={skipped || undefined}
            key={label}
          >
            <span className={styles.railNum}>{index + 1}</span>
            {label}
            {skipped ? <span className="conexSub">no hace falta</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function VariantB(props: VariantProps) {
  const { flow, now, scenario, setFlow } = props;
  const [inWizard, setInWizard] = useState(false);
  const [save, setSave] = useState(false);
  const connected = useConnectedProps(props);

  if (flow.step === "connected") {
    return (
      <>
        {flow.justConnected ? (
          <p className="successBand" role="status">
            MyInvestor conectado. Ahora elige qué cuentas y productos incluir.
          </p>
        ) : null}
        <ConnectedRow {...connected} flow={flow} passwordFoldOpen={false} />
      </>
    );
  }

  const gate = gateOf(scenario);
  if (!inWizard || gate) {
    return (
      <AvailableShell>
        {gate ?? (
          <button
            className={`btnSecondary ${styles.rowCta}`}
            onClick={() => setInWizard(true)}
            type="button"
          >
            Conectar →
          </button>
        )}
      </AvailableShell>
    );
  }

  const current = flow.step === "credentials" ? 0 : flow.step === "sms" ? 1 : 2;
  return (
    <section className={styles.wizard} aria-label="Conectar MyInvestor">
      <p className={styles.fakeUrl}>/ajustes/conexiones/myinvestor</p>
      <button
        className={styles.textControl}
        onClick={() => {
          setInWizard(false);
          setFlow(INITIAL_FLOW);
        }}
        type="button"
      >
        ← Conexiones
      </button>
      <h2 className={styles.wizardTitle}>Conectar MyInvestor</h2>
      <StepRail
        current={current}
        skipSms={scenario.device === "known" && current === 2}
      />

      {flow.step === "credentials" ? (
        <form
          className={`stackForm ${styles.wizardForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            setFlow(submitCredentials("B", scenario, false, now));
          }}
        >
          <p className="muted">
            Entra con el usuario y la contraseña de MyInvestor. worthline solo lee tus
            cuentas, fondos y planes.
          </p>
          <LoginFields />
          {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
          <button type="submit">Continuar</button>
        </form>
      ) : flow.step === "sms" ? (
        <form
          className={`stackForm ${styles.wizardForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            setFlow(submitCode("B", scenario, flow.pending, now));
          }}
        >
          <SmsIntro pending={flow.pending} />
          <CodeField />
          {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
          <button type="submit">Verificar</button>
        </form>
      ) : (
        <form
          className={`stackForm ${styles.wizardForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            setFlow(submitChoice(flow.pending, save, now));
          }}
        >
          <p>
            <strong>Acceso comprobado.</strong> Falta decidir cómo se ponen al día tus
            datos: cuando tú pulses «Poner al día», con la contraseña cada vez, o cada día
            solos.
          </p>
          <RiskCheckbox checked={save} onChange={setSave} />
          {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
          <button type="submit">
            {save ? "Conectar y guardar la contraseña" : "Conectar sin guardarla"}
          </button>
          <p className="muted">
            Lo puedes cambiar luego desde la fila de MyInvestor. Esta pantalla caduca a
            las {clockLabel(flow.pending.since + PENDING_TTL_MIN)}.
          </p>
        </form>
      )}
    </section>
  );
}

// ── C · Conectar sin guardar; la casilla en la fila ────────────────────────

function VariantC(props: VariantProps) {
  const { flow, now, scenario, setFlow } = props;
  const connected = useConnectedProps(props);

  if (flow.step === "connected") {
    return (
      <>
        {flow.justConnected ? (
          <p className="successBand" role="status">
            MyInvestor conectado. Ahora elige qué cuentas y productos incluir. Si quieres
            que se ponga al día solo cada día, lo decides abajo.
          </p>
        ) : null}
        <ConnectedRow {...connected} flow={flow} passwordFoldOpen={flow.justConnected} />
      </>
    );
  }

  const gate = gateOf(scenario);
  return (
    <AvailableShell>
      {gate ?? (
        <details className="conexConnect" open>
          <summary>Conectar</summary>
          {flow.step === "credentials" ? (
            <form
              className="stackForm"
              onSubmit={(event) => {
                event.preventDefault();
                setFlow(submitCredentials("C", scenario, false, now));
              }}
            >
              <LoginFields />
              <p className="muted">
                La contraseña se usa para entrar y se olvida: worthline guarda solo la
                marca de este dispositivo. Que se ponga al día solo cada día se decide
                después, con la conexión hecha.
              </p>
              {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
              <button type="submit">Conectar MyInvestor</button>
            </form>
          ) : flow.step === "sms" ? (
            <form
              className="stackForm"
              onSubmit={(event) => {
                event.preventDefault();
                setFlow(submitCode("C", scenario, flow.pending, now));
              }}
            >
              <SmsIntro pending={flow.pending} />
              <CodeField />
              {flow.error ? <ErrorLine>{flow.error}</ErrorLine> : null}
              <span className={styles.inlineActions}>
                <button type="submit">Verificar</button>
                <button
                  className={styles.textControl}
                  onClick={() => setFlow(INITIAL_FLOW)}
                  type="button"
                >
                  Empezar de nuevo
                </button>
              </span>
            </form>
          ) : null}
        </details>
      )}
    </AvailableShell>
  );
}

// ── Mandos, lectura y conmutador ───────────────────────────────────────────

function Toggle<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (next: T) => void;
  options: readonly (readonly [T, string])[];
  value: T;
}) {
  return (
    <span className={styles.toggle}>
      {label}:
      {options.map(([key, text]) => (
        <button
          aria-pressed={value === key}
          key={key}
          onClick={() => onChange(key)}
          type="button"
        >
          {text}
        </button>
      ))}
    </span>
  );
}

function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: VariantKey;
  onChange: (variant: VariantKey) => void;
}) {
  const index = Math.max(
    0,
    VARIANTS.findIndex((variant) => variant.key === current),
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
        <span className={styles.switcherPrefix}>Prototipo #1879 · </span>
        {VARIANTS[index]?.key} ({VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

export default function ConnectPrototype({
  initialVariant,
}: {
  initialVariant: VariantKey;
}) {
  const [variant, setVariant] = useState<VariantKey>(initialVariant);
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [flow, setFlow] = useState<Flow>(INITIAL_FLOW);
  const [now, setNow] = useState(0);

  const changeVariant = useCallback((next: VariantKey) => {
    setVariant(next);
    setFlow(INITIAL_FLOW);
    const url = new URL(window.location.href);
    url.searchParams.set("variante", next);
    window.history.replaceState(null, "", url);
  }, []);

  const set =
    <K extends keyof Scenario>(key: K) =>
    (value: Scenario[K]) =>
      setScenario((prev) => ({ ...prev, [key]: value }));

  const stored = storedStateOf(flow, now, clockLabel);
  const pending = flow.step === "sms" || flow.step === "choose" ? flow.pending : null;
  const props: VariantProps = { flow, now, scenario, setFlow, variant };

  return (
    <section className={styles.prototype} aria-label="Prototipo #1879">
      {variant === "A" ? <VariantA {...props} /> : null}
      {variant === "B" ? <VariantB {...props} /> : null}
      {variant === "C" ? <VariantC {...props} /> : null}

      <div className={styles.controls}>
        <strong>
          Prototipo #1879 · conectar MyInvestor · lo que contestaría MyInvestor
        </strong>
        <Toggle<Plan>
          label="Plan"
          onChange={set("plan")}
          options={[
            ["premium", "Premium"],
            ["free", "Gratis"],
          ]}
          value={scenario.plan}
        />
        <Toggle<Role>
          label="Permiso"
          onChange={set("role")}
          options={[
            ["editor", "Edita"],
            ["viewer", "Solo ve"],
          ]}
          value={scenario.role}
        />
        <Toggle<Device>
          label="Dispositivo"
          onChange={set("device")}
          options={[
            ["sms", "Pide SMS"],
            ["known", "Ya verificado"],
          ]}
          value={scenario.device}
        />
        <Toggle<LoginOutcome>
          label="Login"
          onChange={set("login")}
          options={[
            ["ok", "Bien"],
            ["password_rejected", "Contraseña mal"],
            ["rejected_no_reason", "Rechazo sin motivo"],
            ["network_or_waf", "Red / WAF"],
          ]}
          value={scenario.login}
        />
        <Toggle<CodeOutcome>
          label="Código"
          onChange={set("code")}
          options={[
            ["ok", "Bien"],
            ["code_rejected", "Equivocado"],
          ]}
          value={scenario.code}
        />
        <span className={styles.toggle}>
          Reloj: {clockLabel(now)}
          <button onClick={() => setNow((n) => n + 6)} type="button">
            +6 min
          </button>
          <button
            onClick={() => {
              setNow(0);
              setFlow(INITIAL_FLOW);
            }}
            type="button"
          >
            Reiniciar
          </button>
        </span>
      </div>

      <dl className={styles.state}>
        <dt>Paso</dt>
        <dd>
          {flow.step}
          {pending && isExpired(pending, now) ? " (el paso pendiente ya caducó)" : ""}
        </dd>
        <dt>Paso pendiente en la BD</dt>
        <dd>{stored.pendingRow}</dd>
        <dt>credentials_json</dt>
        <dd>{stored.credentials}</dd>
        <dt>Aceptación del aviso</dt>
        <dd>{stored.acceptance}</dd>
      </dl>

      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </section>
  );
}
