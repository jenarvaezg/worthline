/**
 * The server pieces of MyInvestor's first start (#1880, design D), around the
 * «Elegir qué incluir» island:
 *
 * - the state cell of the connected row;
 * - «Leer mis productos», when the connection ended without a session to read with
 *   (the SMS proved the device, but the password was not kept): it asks for the
 *   password once, uses it and drops it;
 * - after including, the fold «Productos de MyInvestor» with what was left out, each
 *   with «Incluir con su histórico».
 */

import {
  includeMyInvestorProductsAction,
  readMyInvestorProductsAction,
} from "@web/ajustes/myinvestor-actions";
import {
  isIncludable,
  MYINVESTOR_KIND_LABEL,
  type MyInvestorProductRow,
} from "@web/ajustes/myinvestor-selection";
import { PendingSubmit } from "@web/pending-submit";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import {
  type MyInvestorRowState,
  myInvestorRowNotes,
} from "./myinvestor-first-start-view";

const STATE_CLASS: Record<MyInvestorRowState["kind"], string> = {
  choose: "isPending",
  fresh: "",
  read: "isPending",
  stale: "isStale",
};

/** The status cell of the connected MyInvestor row. */
export function MyInvestorStateCell({
  savedPassword,
  state,
}: {
  savedPassword: boolean;
  state: MyInvestorRowState;
}) {
  return (
    <>
      <span className={`coinStatusPill ${STATE_CLASS[state.kind]}`.trim()}>
        {state.label}
      </span>
      <span className="conexSub">
        {savedPassword ? "Se pone al día sola cada día" : "Se pone al día cuando pulses"}
      </span>
    </>
  );
}

/** «Leer mis productos»: the password only when none is remembered. */
export function MyInvestorReadProducts({
  currentUrl,
  savedPassword,
  sourceId,
}: {
  currentUrl: string;
  savedPassword: boolean;
  sourceId: string;
}) {
  return (
    <form action={readMyInvestorProductsAction} className="stackForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      {savedPassword ? (
        <p className="muted">
          Lee tus cuentas, fondos, planes y efectivo de MyInvestor, con todo su histórico,
          para elegir qué incluir.
        </p>
      ) : (
        <>
          <p className="muted">
            Para leer tus productos, MyInvestor pide tu contraseña otra vez. El
            dispositivo ya está verificado, así que no hay SMS, y la contraseña no se
            guarda.
          </p>
          <label>
            Usuario (DNI o NIE)
            <input autoComplete="off" name="customerId" required type="text" />
          </label>
          <label>
            Contraseña
            <input autoComplete="off" name="password" required type="password" />
          </label>
        </>
      )}
      <PendingSubmit pendingLabel="Leyendo MyInvestor…">Leer mis productos</PendingSubmit>
    </form>
  );
}

/** After the first include: what was left out, each one includable on its own. */
export function MyInvestorIncludedProducts({
  currentUrl,
  privacyMode,
  rows,
  sourceId,
}: {
  currentUrl: string;
  privacyMode: boolean;
  rows: readonly MyInvestorProductRow[];
  sourceId: string;
}) {
  const money = (minor: number) =>
    formatMoneyMinorPrivacy({ amountMinor: minor, currency: "EUR" }, privacyMode);
  const linked = rows.filter((row) => row.linked).length;
  const left = rows.filter((row) => !row.linked);
  return (
    <details suppressHydrationWarning className="conexCredentials">
      <summary>Productos de MyInvestor</summary>
      <p className="muted">
        {linked} {linked === 1 ? "incluido" : "incluidos"}.
        {left.length > 0 ? " Lo que dejaste fuera no toca el patrimonio:" : ""}
      </p>
      {left.length > 0 ? (
        <ul className="myinvestorLeftList">
          {left.map((row) => {
            const notes = myInvestorRowNotes(row, money);
            return (
              <li key={row.key}>
                <span>
                  {row.name}
                  <span className="conexSub">
                    {MYINVESTOR_KIND_LABEL[row.kind]} · {money(row.valueMinor)}
                    {row.otherHolder ? " · de otro titular" : ""}
                  </span>
                  {notes.length > 0 ? (
                    <span className="myinvestorNotes">
                      {notes.map((note) => (
                        <span key={note}>{note}</span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {isIncludable(row) ? (
                  <form action={includeMyInvestorProductsAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="sourceId" type="hidden" value={sourceId} />
                    <input name="productKey" type="hidden" value={row.key} />
                    <PendingSubmit
                      className="myinvestorIncludeLater"
                      pendingLabel="Trayendo el histórico…"
                    >
                      Incluir con su histórico
                    </PendingSubmit>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </details>
  );
}
