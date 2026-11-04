/**
 * How «Poner al día» reads to the user (#1884, design A of the issue): pure words
 * over the connection's sync state and a pass's result, shared by the ficha of a
 * linked holding, its band of avisos and the MyInvestor row of Conexiones.
 *
 * - {@link myInvestorStanding}: the line under «Última vez al día», what STAYS in
 *   the band with its remedy (the design's table), when the button comes back, and
 *   the pass in progress.
 * - {@link myInvestorResultView}: what a press of the button ended in.
 * - {@link myInvestorHealthEntries}: the connection's health signals (#1885), the
 *   ones that come from its attempt log rather than from its last pass.
 *
 * Instants are said in Madrid's hour, the user's, whatever the server's zone.
 */
import {
  formatUnits,
  isPositiveDecimal,
  OWNING_SOURCE_FAILING_WORDS,
  type OwningSourceAttempt,
  type OwningSourceDataKind,
  type OwningSourceStop,
  owningSourceHealth,
  owningSourceStop,
} from "@worthline/domain";
import type { MyInvestorSyncResult } from "./myinvestor-sync";
import {
  type MyInvestorSyncOutcome,
  type MyInvestorUnitsCheckEntry,
  parseMyInvestorSyncOutcome,
} from "./myinvestor-sync-outcome";

const ZONE = "Europe/Madrid";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: ZONE,
  year: "numeric",
});
const HOUR_FORMAT = new Intl.DateTimeFormat("es-ES", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: ZONE,
});
const DATE_FORMAT = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  timeZone: ZONE,
});

function madridDay(iso: string): string {
  return DAY_FORMAT.format(new Date(iso));
}

/** «07:10», in Madrid. */
export function formatMyInvestorHour(iso: string): string {
  return HOUR_FORMAT.format(new Date(iso));
}

/** «hoy a las 17:30», «mañana a las 09:00» or «el 9 de noviembre a las 09:00». */
export function formatMyInvestorWhen(iso: string, now: string): string {
  const day = madridDay(iso);
  const hour = formatMyInvestorHour(iso);
  if (day === madridDay(now)) return `hoy a las ${hour}`;
  const tomorrow = madridDay(new Date(Date.parse(now) + 86_400_000).toISOString());
  if (day === tomorrow) return `mañana a las ${hour}`;
  return `el ${DATE_FORMAT.format(new Date(iso))} a las ${hour}`;
}

/**
 * The last good sync as «Última vez al día» says it, in Madrid: «hoy, 07:12»,
 * «ayer, 07:12», «el 2 de noviembre, 07:12», or «Nunca».
 */
export function formatMyInvestorLastGood(lastSyncAt: string | null, now: string): string {
  if (!lastSyncAt || Number.isNaN(Date.parse(lastSyncAt))) return "Nunca";
  const day = madridDay(lastSyncAt);
  const hour = formatMyInvestorHour(lastSyncAt);
  if (day === madridDay(now)) return `hoy, ${hour}`;
  const yesterday = madridDay(new Date(Date.parse(now) - 86_400_000).toISOString());
  if (day === yesterday) return `ayer, ${hour}`;
  return `el ${DATE_FORMAT.format(new Date(lastSyncAt))}, ${hour}`;
}

export const MYINVESTOR_DAILY_ON = "Se pone al día sola cada día";
export const MYINVESTOR_DAILY_MANUAL = "Se pone al día cuando pulsas";
export const MYINVESTOR_DAILY_STOPPED = "La puesta al día diaria está parada";

/** What a band entry offers to put it right. */
export type MyInvestorRemedy =
  /** Opens the «Poner al día» panel: write the password, try again, resync. */
  | { kind: "panel"; label: string }
  /** The SMS fold of Conexiones (#1879). */
  | { kind: "conexiones"; label: string };

/** One entry of the band: the connection's lasting state, or one holding's units. */
export interface MyInvestorBandEntry {
  text: string;
  tone: "warn" | "error";
  remedy: MyInvestorRemedy | null;
}

/** What the state row says, as the ficha and Conexiones read it. */
export interface MyInvestorStateInput {
  pausedUntil: string | null;
  stoppedReason: string | null;
  lastOutcomeJson: string | null;
  lease: {
    until: string;
    startedAt: string;
    trigger: "cron" | "manual";
    step?: string | null;
  } | null;
}

export interface MyInvestorStanding {
  dailyLine: string;
  /** The connection's entry in the band, or null when nothing lasts. */
  lasting: MyInvestorBandEntry | null;
  /** The button cannot be used yet, and when it comes back. */
  blocked: { line: string } | null;
  /** A pass is running now (the cron's, or another tab's), since this hour. */
  running: { since: string } | null;
  /** What the last pass ended in, for a panel that did not see it happen. */
  lastLine: string | null;
  /** Why the periodic sync is stopped until the user acts, or null (#1885). */
  stop: OwningSourceStop | null;
}

const PASSWORD_FORGOTTEN: MyInvestorBandEntry = {
  remedy: { kind: "panel", label: "Escribir la contraseña" },
  text: "MyInvestor no acepta la contraseña guardada, así que worthline la ha borrado. La puesta al día diaria está parada.",
  tone: "error",
};

const SMS_REQUIRED: MyInvestorBandEntry = {
  remedy: { kind: "conexiones", label: "Verificar el móvil en Conexiones →" },
  text: "MyInvestor pide verificar el móvil otra vez. La puesta al día diaria está parada hasta que lo hagas; worthline nunca manda un SMS solo.",
  tone: "error",
};

const LOCKED: MyInvestorBandEntry = {
  remedy: null,
  text: "MyInvestor ha rechazado la contraseña tres veces hoy. La conexión queda bloqueada hasta mañana para no bloquearte la cuenta.",
  tone: "error",
};

const NO_REASON: MyInvestorBandEntry = {
  remedy: null,
  text: "MyInvestor ha rechazado la entrada sin decir por qué. worthline espera 24 horas antes de volver a intentarlo.",
  tone: "warn",
};

const LIMIT: MyInvestorBandEntry = {
  remedy: null,
  text: "Hoy ya se ha entrado 10 veces en MyInvestor, el máximo. Vuelve a intentarlo mañana.",
  tone: "warn",
};

const NETWORK: MyInvestorBandEntry = {
  remedy: { kind: "panel", label: "Volver a intentarlo" },
  text: "No hemos podido hablar con MyInvestor tras tres intentos. No ha cambiado nada; vuelve a intentarlo en unos minutos.",
  tone: "error",
};

const FAILED: MyInvestorBandEntry = {
  remedy: { kind: "panel", label: "Volver a intentarlo" },
  text: "MyInvestor ha contestado algo que no esperábamos. No ha cambiado nada; vuelve a intentarlo más tarde.",
  tone: "error",
};

function blockedLine(until: string, now: string, locked: boolean): string {
  return locked
    ? "«Poner al día» vuelve mañana."
    : `«Poner al día» vuelve ${formatMyInvestorWhen(until, now)}.`;
}

/** The connection as it stands at `now`. */
export function myInvestorStanding(input: {
  state: MyInvestorStateInput | null;
  savedPassword: boolean;
  now: string;
}): MyInvestorStanding {
  const { now, savedPassword, state } = input;
  const outcome = parseMyInvestorSyncOutcome(state?.lastOutcomeJson ?? null);
  const paused = state?.pausedUntil && state.pausedUntil > now ? state.pausedUntil : null;
  // The stop is read by the same rule data health reads it with (#1885).
  const stop = myInvestorStop(state, savedPassword);
  const stoppedBySms = stop === "sms_required";
  const forgotten = stop === "password_forgotten";

  const dailyLine =
    stoppedBySms || forgotten
      ? MYINVESTOR_DAILY_STOPPED
      : savedPassword
        ? MYINVESTOR_DAILY_ON
        : MYINVESTOR_DAILY_MANUAL;

  let lasting: MyInvestorBandEntry | null = null;
  let blocked: MyInvestorStanding["blocked"] = null;
  if (paused) {
    const locked = outcome?.kind === "locked";
    lasting = locked ? LOCKED : NO_REASON;
    blocked = { line: blockedLine(paused, now, locked) };
  } else if (stoppedBySms) {
    lasting = SMS_REQUIRED;
  } else if (forgotten) {
    lasting = PASSWORD_FORGOTTEN;
  } else if (outcome?.kind === "limit" && outcome.at.slice(0, 10) === now.slice(0, 10)) {
    // The logins are counted per the app's calendar day (UTC), as the pass counts them.
    lasting = LIMIT;
    blocked = { line: "«Poner al día» vuelve mañana." };
  } else if (outcome?.kind === "network") {
    lasting = NETWORK;
  } else if (outcome?.kind === "failed") {
    lasting = FAILED;
  }

  const lease = state?.lease ?? null;
  const running =
    lease && lease.until > now ? { since: formatMyInvestorHour(lease.startedAt) } : null;

  const lastLine = outcome ? outcomeView(outcome, now).text : null;
  return { blocked, dailyLine, lastLine, lasting, running, stop };
}

/** Why the periodic sync is stopped, by the rule data health also reads (#1885). */
function myInvestorStop(state: MyInvestorStateInput | null, savedPassword: boolean) {
  const outcome = parseMyInvestorSyncOutcome(state?.lastOutcomeJson ?? null);
  return owningSourceStop({
    lastOutcome: outcome
      ? {
          forgotten: outcome.kind === "password_rejected" ? outcome.forgotten : null,
          kind: outcome.kind,
        }
      : null,
    savedPassword,
    stoppedReason: state?.stoppedReason ?? null,
  });
}

/** Where a health signal sends the user: the connection, where each is put right. */
const SEE_CONNECTION: MyInvestorRemedy = {
  kind: "conexiones",
  label: "Ver la conexión →",
};

/** What still reads when one kind fails; the rest of the sentence is data health's. */
const FAILING_STILL_READ: Record<OwningSourceDataKind, string | null> = {
  orders: "Las posiciones sí se leen",
  plans: "Las posiciones y las órdenes sí se leen",
  positions: null,
};

function failingRest(data: OwningSourceDataKind): string {
  const { effect } = OWNING_SOURCE_FAILING_WORDS[data];
  const stillRead = FAILING_STILL_READ[data];
  return stillRead === null
    ? `${effect.charAt(0).toUpperCase()}${effect.slice(1)}.`
    : `${stillRead}; ${effect}.`;
}

/**
 * The connection's health signals (#1885, design A of #1884/#1885): «El conector
 * falla» per kind of data after three days in a row, and the reminder at 45 days
 * with no saved password. The stops (the SMS, the rejected password) are the
 * standing's `lasting`, so they are not said twice here. The rules are the domain's
 * ({@link owningSourceHealth}), the same data health reads; the days are the app's
 * calendar days (UTC), as the logins are counted.
 */
export function myInvestorHealthEntries(input: {
  /** The attempt log, newest first. */
  attempts: readonly OwningSourceAttempt[];
  state: MyInvestorStateInput | null;
  savedPassword: boolean;
  lastSyncAt: string | null;
  now: string;
}): MyInvestorBandEntry[] {
  const notices = owningSourceHealth(
    {
      attempts: input.attempts,
      lastSyncAt: input.lastSyncAt,
      savedPassword: input.savedPassword,
      stop: myInvestorStop(input.state, input.savedPassword),
    },
    input.now.slice(0, 10),
  );
  return notices.flatMap((notice): MyInvestorBandEntry[] => {
    switch (notice.kind) {
      case "failing": {
        const { read } = OWNING_SOURCE_FAILING_WORDS[notice.data];
        return [
          {
            remedy: SEE_CONNECTION,
            text: `El conector falla al leer ${read} desde hace ${notice.days} días. ${failingRest(notice.data)}`,
            tone: "warn",
          },
        ];
      }
      case "unsynced":
        return [
          {
            remedy: SEE_CONNECTION,
            text: `Llevas ${notice.days} días sin poner al día MyInvestor. Sin la contraseña guardada, solo se pone al día cuando pulsas.`,
            tone: "warn",
          },
        ];
      default:
        return [];
    }
  });
}

/**
 * What the MyInvestor row of Conexiones says under it (#1885): the connection's
 * lasting state, then its health signals. When the button comes back is not
 * repeated here: the row's «Poner al día» already says it under the button. The
 * ficha's band says the same, each with its way out (`owningSourceNotices`).
 */
export function myInvestorConnectionNotices(
  standing: MyInvestorStanding,
  health: readonly MyInvestorBandEntry[],
): MyInvestorBandEntry[] {
  return standing.lasting ? [standing.lasting, ...health] : [...health];
}

/** The band's line for a linked holding whose units do not square (P8). */
export function myInvestorUnitsLine(entry: MyInvestorUnitsCheckEntry): string {
  const sign = isPositiveDecimal(entry.difference) ? "+" : "";
  return (
    `Las participaciones no cuadran: el libro dice ${formatUnits(entry.bookUnits)} ` +
    `y MyInvestor ${formatUnits(entry.sourceUnits)} (${sign}${formatUnits(entry.difference)}). ` +
    "Las operaciones nuevas están aplicadas; worthline no crea ningún ajuste."
  );
}

export const MYINVESTOR_RESYNC_LABEL = "Resincronizar todo";

/** What a press of the button shows once it resolves. */
export interface MyInvestorResultView {
  tone: "ok" | "warn" | "error";
  text: string;
  /** When the button comes back, for a refused or blocked press. */
  blockedLine: string | null;
}

function operationsLine(applied: number): string {
  if (applied === 0) return "Al día: nada nuevo.";
  return applied === 1
    ? "Al día: 1 operación nueva."
    : `Al día: ${applied} operaciones nuevas.`;
}

function outcomeView(outcome: MyInvestorSyncOutcome, now: string): MyInvestorResultView {
  switch (outcome.kind) {
    case "ok": {
      const head = outcome.resynced
        ? "Resincronizado: todo el histórico leído otra vez."
        : operationsLine(outcome.applied);
      return outcome.mismatches > 0
        ? {
            blockedLine: null,
            text: `${head} Las participaciones no cuadran: lo tienes en los avisos, con «${MYINVESTOR_RESYNC_LABEL}».`,
            tone: "warn",
          }
        : { blockedLine: null, text: head, tone: "ok" };
    }
    case "password_rejected":
      return outcome.forgotten
        ? { blockedLine: null, text: PASSWORD_FORGOTTEN.text, tone: "error" }
        : {
            blockedLine: null,
            text: "MyInvestor no acepta ese usuario o esa contraseña. No ha cambiado nada.",
            tone: "error",
          };
    case "locked":
      return {
        blockedLine: blockedLine(outcome.until, now, true),
        text: LOCKED.text,
        tone: "error",
      };
    case "rejected_no_reason":
      return {
        blockedLine: blockedLine(outcome.until, now, false),
        text: NO_REASON.text,
        tone: "warn",
      };
    case "sms_required":
      return { blockedLine: null, text: SMS_REQUIRED.text, tone: "error" };
    case "network":
      return { blockedLine: null, text: NETWORK.text, tone: "error" };
    case "limit":
      return {
        blockedLine: "«Poner al día» vuelve mañana.",
        text: LIMIT.text,
        tone: "warn",
      };
    default:
      return { blockedLine: null, text: FAILED.text, tone: "error" };
  }
}

/** A press of the button, resolved. `skipped` is the cron's and never reaches here. */
export function myInvestorResultView(
  result: MyInvestorSyncResult,
  now: string,
): MyInvestorResultView {
  switch (result.status) {
    case "done": {
      const view = outcomeView(result.outcome, now);
      return result.waited && result.outcome.kind === "ok"
        ? {
            ...view,
            text: `${view.text} Ya se estaba poniendo al día y has esperado a que terminara.`,
          }
        : view;
    }
    case "blocked":
      return {
        blockedLine: blockedLine(result.until, now, result.reason === "locked"),
        text: result.reason === "locked" ? LOCKED.text : NO_REASON.text,
        tone: "warn",
      };
    case "password_needed":
      return {
        blockedLine: null,
        text: "Escribe tu usuario y tu contraseña de MyInvestor para ponerlo al día.",
        tone: "error",
      };
    default:
      return {
        blockedLine: null,
        text: "No se encontró la conexión de MyInvestor.",
        tone: "error",
      };
  }
}
