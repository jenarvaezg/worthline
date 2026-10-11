import { PREMIUM_INCLUDES } from "@web/entitlements/paywall-copy";
import { TRIAL_EMAIL_KINDS, type TrialEmailKind } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { buildTrialEmail, formatTrialDate } from "./trial-email-messages";

const SITE = "https://worthline.example";
const OPT_OUT = `${SITE}/correo/recordatorios?t=abc.def`;

function build(kind: TrialEmailKind, overrides: { replyTo?: string | null } = {}) {
  return buildTrialEmail(kind, {
    optOutUrl: OPT_OUT,
    replyTo: overrides.replyTo ?? null,
    siteUrl: SITE,
    to: "ana@example.com",
    trialEndsAt: "2026-10-04T10:00:00.000Z",
  });
}

describe("trial email copy (#1173)", () => {
  test("dates read as a day in Spain, where the product speaks", () => {
    expect(formatTrialDate("2026-10-04T10:00:00.000Z")).toBe("4 de octubre de 2026");
    // 23:30 UTC on the 4th is already the 5th in Madrid (CEST, UTC+2).
    expect(formatTrialDate("2026-10-04T23:30:00.000Z")).toBe("5 de octubre de 2026");
  });

  test("welcome: what worthline is, the live trial with its end, and the way into onboarding", () => {
    const email = build("welcome");
    expect(email.to).toBe("ana@example.com");
    expect(email.subject).toBe("Te damos la bienvenida a worthline");
    expect(email.text).toContain("La prueba termina el 4 de octubre de 2026.");
    expect(email.text).toContain(`${SITE}/bienvenida`);
    expect(email.text).toContain(`${SITE}/premium`);
    // Honest about the after: no card, no charge, nothing deleted.
    expect(email.text).toContain("no se te cobra nada");
    expect(email.text).toContain("no se borra nada");
    // It announces the two reminders and how to decline them.
    expect(email.text).toContain("un aviso antes de que termine y otro cuando termine");
    expect(email.text).toContain(OPT_OUT);
  });

  test("day-2 reminder: what expires and what never does, with no pressure to act", () => {
    const email = build("trial_reminder");
    expect(email.subject).toBe("Tu prueba de premium termina el 4 de octubre");
    expect(email.text).toContain("termina el 4 de octubre de 2026");
    expect(email.text).toContain("Lo que deja de estar incluido ese día");
    expect(email.text).toContain("Lo que no cambia");
    expect(email.text).toContain("se queda; no se borra nada");
    expect(email.text).toContain("siguen siendo gratis, para siempre");
    expect(email.text).toContain("No tienes que hacer nada");
    expect(email.text).toContain(`${SITE}/premium`);
    expect(email.text).toContain(OPT_OUT);
  });

  test("day-2 reminder never claims a welcome it cannot know was received", () => {
    // The welcome's retry window can pass, its claim can stick unsent, or the
    // trial can predate these emails: «como te contamos» would be false then.
    expect(build("trial_reminder").text).not.toMatch(/como te contamos|bienvenida/i);
  });

  test("day-2 reminder lists every premium gate as what stops, from the paywall's own list", () => {
    const { text } = build("trial_reminder");
    // Named independently of the list, as the paywall gates them (paywall-copy.ts).
    expect(text).toContain("importar extractos de broker");
    expect(text).toContain("conectar fuentes de datos nuevas");
    expect(text).toContain("sincronizando solas");
    expect(text).toContain("justificantes");
    expect(text).toContain("cupo mensual de mensajes de cortesía");
    for (const line of PREMIUM_INCLUDES) expect(text).toContain(`- ${line}`);
  });

  test("expiry: the fall to free without loss, how to come back, and that it is the last one", () => {
    const email = build("trial_expired");
    expect(email.subject).toBe("Tu prueba de premium ha terminado");
    expect(email.text).toContain("tu cuenta está ahora en el plan gratuito");
    expect(email.text).toContain("No has perdido nada");
    expect(email.text).toContain(`${SITE}/premium`);
    expect(email.text).toContain("Este es el último correo sobre la prueba.");
    // Nothing follows it, so there is nothing to opt out of.
    expect(email.text).not.toContain(OPT_OUT);
  });

  test.each(TRIAL_EMAIL_KINDS)("%s names no price and fakes no urgency", (kind) => {
    const { subject, text } = build(kind);
    const whole = `${subject}\n${text}`;
    // Prices live in the local plan, never in a mail (#1173).
    expect(whole).not.toMatch(/€|\bEUR\b|\bprecio|\/mes\b|\d+[.,]\d{2}/i);
    expect(whole).not.toMatch(
      /!|últim[ao]s? (horas|oportunidad)|date prisa|no te lo pierdas|solo quedan|corre\b|ahora o nunca|oferta/i,
    );
  });

  test.each(
    TRIAL_EMAIL_KINDS,
  )("%s is tagged by kind and replies to the contact when there is one", (kind) => {
    expect(build(kind).tags).toEqual([{ name: "kind", value: kind }]);
    expect(build(kind).replyTo).toBeUndefined();
    expect(build(kind, { replyTo: "hola@example.com" }).replyTo).toBe("hola@example.com");
  });
});
