/**
 * The copy of the three trial emails (#1173, PRD #1171 S2).
 *
 * The product's honest brand, written down: inform, never press. Each email
 * says what happens and what does NOT, names a real date instead of a countdown,
 * and leaves «no hacer nada» as a perfectly fine answer. Rules the tests pin:
 *
 *  - **no price**, ever: the figures live in the local plan, out of git, and a
 *    mail would freeze one that may change — the link to `/premium` says it;
 *  - **no fake urgency**: no exclamation marks, no «últimas horas», no offer;
 *  - the welcome **announces** the two reminders and how to decline them, so
 *    the person decides before the first one arrives; the expiry notice says it
 *    is the last one.
 *
 * Plain text on purpose, like the feedback mail (`send-email.ts`): nothing to
 * escape, nothing that renders differently per client, and nothing tracking.
 */

import type { EmailMessage } from "@web/email/send-email";
import { PREMIUM_INCLUDES } from "@web/entitlements/paywall-copy";
import type { TrialEmailKind } from "@worthline/db";

/** Where the product speaks: a day in Spain, not a UTC instant. */
const DATE_TIME_ZONE = "Europe/Madrid";

export interface TrialEmailInput {
  to: string;
  trialEndsAt: string;
  /** Absolute origin for the links, without a trailing slash. */
  siteUrl: string;
  /** The signed «no recibir recordatorios» link for this identity. */
  optOutUrl: string;
  /** The contact address a reply goes to, or null to leave the provider's default. */
  replyTo: string | null;
}

/** «4 de octubre de 2026». */
export function formatTrialDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: DATE_TIME_ZONE,
    year: "numeric",
  });
}

/** «4 de octubre» — the subject line does without the year. */
function formatTrialDay(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: DATE_TIME_ZONE,
  });
}

const SIGNATURE = "— worthline";

/** A plain-text list: «- uno;», «- dos.» */
function bulletList(lines: readonly string[]): string[] {
  return lines.map((line, index) => `- ${line}${index === lines.length - 1 ? "." : ";"}`);
}

function welcome(input: TrialEmailInput): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: "Te damos la bienvenida a worthline",
    text: [
      "Hola:",
      "",
      "Ya tienes tu cuenta de worthline: un libro de cuentas para tu patrimonio, con lo que tienes, lo que debes y cómo evoluciona, en un mismo sitio.",
      "",
      `Estos primeros días tienes premium completo para probarlo: el asistente lee tus extractos y documentos por ti y las fuentes que conectes se sincronizan solas. La prueba termina el ${formatTrialDate(input.trialEndsAt)}. No te hemos pedido tarjeta, así que al terminar no se te cobra nada y no se borra nada: tu cuenta pasa sola al plan gratuito, con tus datos intactos y el seguimiento manual gratis para siempre.`,
      "",
      "Para empezar, el asistente te acompaña en unos minutos:",
      `${input.siteUrl}/bienvenida`,
      "",
      "Qué incluye premium y qué es gratis:",
      `${input.siteUrl}/premium`,
      "",
      "Te escribiremos dos veces más, y solo sobre la prueba: un aviso antes de que termine y otro cuando termine. Si prefieres no recibirlos:",
      input.optOutUrl,
      "",
      SIGNATURE,
    ].join("\n"),
  };
}

function reminder(input: TrialEmailInput): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: `Tu prueba de premium termina el ${formatTrialDay(input.trialEndsAt)}`,
    text: [
      "Hola:",
      "",
      // No «como te contamos»: the welcome may never have reached this person
      // (its retry window passed, or the trial predates these emails).
      `Te avisamos antes de que acabe tu prueba de premium en worthline: termina el ${formatTrialDate(input.trialEndsAt)}.`,
      "",
      // The same list the paywall gates, so «what stops» never drifts from it.
      "Lo que deja de estar incluido ese día:",
      ...bulletList(PREMIUM_INCLUDES),
      "",
      "Lo que no cambia:",
      "- todo lo que has registrado o importado se queda; no se borra nada;",
      "- el seguimiento manual y todas las lentes siguen siendo gratis, para siempre.",
      "",
      "No tienes que hacer nada: si no sigues con premium, tu cuenta pasa sola al plan gratuito y no se te cobra nada. Si quieres seguir con premium:",
      `${input.siteUrl}/premium`,
      "",
      "¿Prefieres no recibir más avisos sobre la prueba?",
      input.optOutUrl,
      "",
      SIGNATURE,
    ].join("\n"),
  };
}

function expired(input: TrialEmailInput): Pick<EmailMessage, "subject" | "text"> {
  return {
    subject: "Tu prueba de premium ha terminado",
    text: [
      "Hola:",
      "",
      `Tu prueba de premium en worthline terminó el ${formatTrialDate(input.trialEndsAt)} y tu cuenta está ahora en el plan gratuito. No se te ha cobrado nada.`,
      "",
      "No has perdido nada: todo lo que registraste o importaste sigue ahí, y el seguimiento manual y todas las lentes siguen siendo gratis. Si conectaste fuentes de datos, quedan en pausa con lo último que importaron.",
      "",
      "Si en algún momento quieres volver a premium:",
      `${input.siteUrl}/premium`,
      "",
      "Este es el último correo sobre la prueba.",
      "",
      SIGNATURE,
    ].join("\n"),
  };
}

const COPY: Record<
  TrialEmailKind,
  (input: TrialEmailInput) => Pick<EmailMessage, "subject" | "text">
> = {
  trial_expired: expired,
  trial_reminder: reminder,
  welcome,
};

export function buildTrialEmail(
  kind: TrialEmailKind,
  input: TrialEmailInput,
): EmailMessage {
  return {
    ...COPY[kind](input),
    tags: [{ name: "kind", value: kind }],
    to: input.to,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
}
