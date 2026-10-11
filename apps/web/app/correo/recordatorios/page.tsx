import { readLegalIdentity } from "@web/legal/legal-identity";
import {
  REMINDER_OPT_OUT_PARAM,
  reminderOptOutSecret,
  verifyReminderOptOutToken,
} from "@web/trial-emails/reminder-opt-out-token";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import ReminderOptOutForm from "./reminder-opt-out-form";

/**
 * Block (#1229): this route opts out of Instant Navigations validation. It is
 * opened from an email, never navigated to from inside the app.
 */
export const instant = false;

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Avisos sobre tu prueba",
};

/**
 * /correo/recordatorios — where the «no recibir recordatorios» link of the trial
 * emails lands (#1173). Public on purpose (`auth-gate.ts`): it must work from
 * the inbox with no sign-in, and the signed token is the only credential — the
 * page acts on the identity it names and shows nothing about it.
 *
 * Opening the link changes nothing: the opt-out takes a press of the button.
 * Mail scanners and link previews follow every link they see, and an
 * unsubscribe that fired on a GET would be undone by a security filter before
 * the person ever read the email.
 *
 * Cover register (#829/#909), the same sheet as the legal texts: a threshold
 * around the book, not work inside it.
 */
export default async function TrialRemindersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // The secret is runtime configuration: never let a prerender freeze it.
  await connection();
  const raw = params[REMINDER_OPT_OUT_PARAM];
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? null;
  const valid = verifyReminderOptOutToken(token, reminderOptOutSecret()) !== null;
  const contactEmail = readLegalIdentity().contactEmail;

  return (
    <main className="legalPage coverSurface">
      <header className="legalMasthead">
        <Link className="brand legalBrand" href="/">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Correo</p>
          </div>
        </Link>
      </header>

      <article className="legalSheet coverSheet">
        <h2>Avisos sobre tu prueba</h2>
        {valid && token ? (
          <>
            <p className="legalLede">
              Durante la prueba de premium te escribimos dos veces: un aviso antes de que
              termine y otro cuando termina.
            </p>
            <p>
              Si no quieres recibirlos, pulsa el botón. No cambia nada más: tu cuenta, tu
              plan y tus datos siguen igual, y puedes pasarte a premium cuando quieras
              desde la aplicación.
            </p>
            <ReminderOptOutForm token={token} />
          </>
        ) : (
          <p>
            Este enlace no es válido o está incompleto. Vuelve a abrirlo desde el correo
            {contactEmail ? (
              <>
                {" "}
                o, si sigue sin funcionar, escribe a{" "}
                <a href={`mailto:${contactEmail}`}>{contactEmail}</a> y lo hacemos por ti
              </>
            ) : null}
            .
          </p>
        )}
      </article>
    </main>
  );
}
