"use client";

/**
 * «Acceso de solo lectura» (#1844, S4 of #1718, ADR 0112): the owner gives a
 * read-only view of their workspace by email, sees who has it and since when, and
 * takes it back.
 *
 * A client island only for the optimism (interaction-patterns §4/§7): giving and
 * taking access fold over the server's list through the pure
 * `applyViewerMutation`, and a refusal the client can already see is decided by
 * the pure `planShare` before anything is sent, so a row never appears only to
 * vanish. The row IS what the owner typed, so the optimistic row is the stored
 * one; the server stays the authority and decides everything again.
 *
 * Every submit leaves from its handler with `inlineError=1` stamped on the body,
 * never in the HTML (#1311): a refusal comes back as state and the optimistic row
 * reverts with the reason beside the door. Without JavaScript both forms post
 * plainly to the same actions and a refusal comes back on the URL.
 *
 * Rendered only for a session acting on its own account (`readOnlySharingSections`): the
 * demo, an admin impersonating and a viewer never see a sharing control.
 */

import type { FormActionState } from "@web/form-action";
import {
  applyViewerMutation,
  MAX_VIEWERS,
  submitRevoke,
  submitShare,
  type ViewerMutation,
  type ViewerRow,
  viewerSinceLabel,
} from "@web/sharing/read-only-sharing";
import { type FormEvent, useOptimistic, useState, useTransition } from "react";

type SharingAction = (formData: FormData) => Promise<FormActionState>;

/** `action=` is the no-JS path; React discards what it resolves to there. */
function asFormAction(action: SharingAction) {
  return action as unknown as (formData: FormData) => void | Promise<void>;
}

export function ReadOnlyAccessSection({
  initialEmail,
  initialError,
  ownerEmail,
  revokeAction,
  shareAction,
  today,
  viewers,
}: {
  /** What a refused no-JS share typed, brought back on the URL. */
  initialEmail: string;
  initialError: string | null;
  ownerEmail: string;
  revokeAction: SharingAction;
  shareAction: SharingAction;
  /** The day a new row says it was given (`YYYY-MM-DD`). */
  today: string;
  viewers: readonly ViewerRow[];
}) {
  const [rows, applyOptimistic] = useOptimistic(
    viewers,
    (current: readonly ViewerRow[], mutation: ViewerMutation) =>
      applyViewerMutation(current, mutation),
  );
  const [email, setEmail] = useState(initialEmail);
  const [refusal, setRefusal] = useState<string | null>(initialError);
  const [isSaving, startSaving] = useTransition();

  // No in-flight gate: a second submit while one travels is sent too, never
  // dropped in silence (`submitShare` plans against the rows still pending).
  function onShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitShare({
      action: shareAction,
      formData: new FormData(event.currentTarget),
      onRefusal: setRefusal,
      ownerEmail,
      rows: () => rows,
      setDraft: setEmail,
      showOptimistic: applyOptimistic,
      startTransition: startSaving,
      today,
    });
  }

  const onRevoke = (userId: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitRevoke({
      action: revokeAction,
      formData: new FormData(event.currentTarget),
      onRefusal: setRefusal,
      showOptimistic: applyOptimistic,
      startTransition: startSaving,
      userId,
    });
  };

  return (
    <section aria-label="Acceso de solo lectura" className="ajustesPanel section">
      <div className="panelHeader">
        <h2>Acceso de solo lectura</h2>
        <span>
          {rows.length} de {MAX_VIEWERS}
        </span>
      </div>
      <p className="muted">
        Verá todas tus cifras y fichas. No podrá cambiar nada, ni usar el asistente, ni
        descargar la exportación. Puedes quitarle el acceso cuando quieras. Avísale tú:
        entrará con su cuenta de Google de esa dirección.
      </p>
      <p aria-live="polite" className="srOnly">
        {isSaving ? "Guardando…" : ""}
      </p>

      {rows.length === 0 ? (
        <p className="emptyLine">Nadie más ve tu espacio.</p>
      ) : (
        <ul className="sharingList">
          {rows.map((row) => (
            <li className="sharingRow" key={row.userId ?? `pending:${row.email}`}>
              <span className="sharingWho">
                <span className="sharingEmail">{row.email}</span>
                <span className="sharingSince">{viewerSinceLabel(row.since)}</span>
              </span>
              {row.userId === null ? (
                <span className="sharingSince">Guardando…</span>
              ) : (
                <form action={asFormAction(revokeAction)} onSubmit={onRevoke(row.userId)}>
                  <input name="viewerUserId" type="hidden" value={row.userId} />
                  {/* Reversible —the owner can give access again— so it is a
                      warning, not the red of what cannot be undone. */}
                  <details
                    className="confirmDelete confirmReversible"
                    suppressHydrationWarning
                  >
                    <summary
                      aria-label={`Quitar acceso a ${row.email}`}
                      className="btnSmall btnWarning"
                    >
                      Quitar acceso
                    </summary>
                    <button
                      aria-label={`Confirmar: quitar acceso a ${row.email}`}
                      className="btnSmall btnWarning"
                      type="submit"
                    >
                      Confirmar: quitar acceso
                    </button>
                  </details>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* `noValidate`: the section's own words say what is wrong with an address,
          the same words the server would use, instead of the browser's bubble. */}
      <form
        action={asFormAction(shareAction)}
        className="inlineForm"
        noValidate
        onSubmit={onShare}
      >
        <input
          aria-label="Email de la persona a la que das acceso"
          autoComplete="off"
          name="viewerEmail"
          onChange={(event) => setEmail(event.currentTarget.value)}
          placeholder="nombre@ejemplo.com"
          type="email"
          value={email}
        />
        <button type="submit">Dar acceso</button>
        {refusal ? (
          <p className="formError" role="alert">
            {refusal}
          </p>
        ) : null}
      </form>
    </section>
  );
}
