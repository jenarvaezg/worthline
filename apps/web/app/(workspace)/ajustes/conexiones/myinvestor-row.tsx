/**
 * The MyInvestor rows of «Conexiones» (#1879, design A), explicit per provider
 * (ADR 0043): its connect fold is two steps and its connected row carries the
 * remembered password, neither of which the mirroring sources have.
 *
 * - «Sin conectar»: the connect fold, or ONE line saying why there is none
 *   (relay, write access, premium).
 * - Connected, under its row: the fold of the remembered password — with when and
 *   who accepted it and «Dejar de guardarla», or the form to start remembering it —
 *   and the disconnect fold.
 */

import {
  disconnectMyInvestorAction,
  forgetMyInvestorPasswordAction,
} from "@web/ajustes/myinvestor-actions";
import type { MyInvestorAcceptance } from "@web/ajustes/myinvestor-credentials";
import { formatLastSync } from "@web/ajustes/numista-helpers";
import { PREMIUM_CTA } from "@web/entitlements/paywall-copy";
import { PendingSubmit } from "@web/pending-submit";
import MyInvestorConnectFold, {
  MyInvestorSavePasswordForm,
} from "./myinvestor-connect-fold";
import {
  type MyInvestorAvailability,
  myInvestorPasswordAcceptedBy,
} from "./myinvestor-view";

/** What the «Sin conectar» row of MyInvestor shows under its name. */
export function MyInvestorAvailable({
  availability,
  currentUrl,
}: {
  availability: MyInvestorAvailability;
  currentUrl: string;
}) {
  switch (availability.kind) {
    case "connect":
      return <MyInvestorConnectFold currentUrl={currentUrl} />;
    case "premium":
      return (
        <p className="muted myinvestorGate">
          {availability.text}{" "}
          <a className="actionLink" href={PREMIUM_CTA.href}>
            {PREMIUM_CTA.label}
          </a>
        </p>
      );
    case "line":
      return <p className="muted myinvestorGate">{availability.text}</p>;
  }
}

/** The folds under the connected MyInvestor row. */
export function MyInvestorConnectedDetail({
  currentUrl,
  errorFormId,
  passwordFormId,
  disconnectFormId,
  savedPassword,
  sourceId,
  viewerEmail,
}: {
  currentUrl: string;
  /** The `formId` of the error in the URL, to reopen the fold that sent it. */
  errorFormId: string | null;
  passwordFormId: string;
  disconnectFormId: string;
  savedPassword: MyInvestorAcceptance | null;
  sourceId: string;
  viewerEmail: string | null;
}) {
  return (
    <>
      <details
        suppressHydrationWarning
        className="conexCredentials"
        open={errorFormId === passwordFormId}
      >
        <summary>
          {savedPassword ? "Contraseña guardada" : "Ponerse al día sola cada día"}
        </summary>
        {savedPassword ? (
          <form action={forgetMyInvestorPasswordAction} className="stackForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="sourceId" type="hidden" value={sourceId} />
            <p className="muted">
              Guardada desde el {formatLastSync(savedPassword.acceptedAt)}.{" "}
              {myInvestorPasswordAcceptedBy(savedPassword.acceptedBy, viewerEmail)}{" "}
              worthline la usa para poner tus datos al día cada día; nunca manda un SMS.
            </p>
            <PendingSubmit className="btnSecondary" pendingLabel="Borrando…">
              Dejar de guardarla
            </PendingSubmit>
          </form>
        ) : (
          <MyInvestorSavePasswordForm currentUrl={currentUrl} sourceId={sourceId} />
        )}
      </details>
      <details
        suppressHydrationWarning
        className="conexCredentials"
        open={errorFormId === disconnectFormId}
      >
        <summary>Desconectar</summary>
        <form action={disconnectMyInvestorAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="sourceId" type="hidden" value={sourceId} />
          <p className="muted">
            Se borran ya las credenciales. Lo que hubieras incluido o enlazado se queda
            como manual, con las operaciones de MyInvestor: las tuyas que sustituyó no
            vuelven.
          </p>
          <PendingSubmit className="btnSecondary" pendingLabel="Desconectando…">
            Desconectar MyInvestor
          </PendingSubmit>
        </form>
      </details>
    </>
  );
}
