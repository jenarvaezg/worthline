/**
 * Danger zone — the Papelera's door (#1365, then #1549).
 *
 * For a holding with nothing inside the copy that has always been here is the whole
 * truth: it moves to the Papelera and can be recovered. For a holding whose position
 * still holds units it is not — the value leaves the patrimonio at the next capture
 * and the histórico records no sale, no traspaso, and no deposit into any account.
 * That is the Groupama episode (#1365): 7.642 € gone from a real book with nothing
 * to explain them.
 *
 * #1365 gave that case a warning. #1549 gives it a DOOR: three exits, and none of
 * them evaporates money.
 *
 * - **«Lo vendí»** — the sale is recorded here, from the two figures a bank
 *   confirmation states (date and importe), and the holding is archived after it.
 * - **«Lo traspasé a…»** — the link goes to this same ficha's Traspasar surface,
 *   which is the ONE door a traspaso enters the book by (ADR 0083); arriving from
 *   here it archives the origin itself once the pair leaves it empty.
 * - **«Fue un error de registro»** — archives with the value inside, and says on the
 *   row that the value was never real.
 *
 * Everything is disclosed with CSS `:has()` and no field carries a native
 * `required`, for the reason the add wizard learned the hard way (#677): a
 * constraint inside a `display:none` pane aborts the submit of the whole form. The
 * server (`deleteAssetAction`, and under it the gate in `softDeleteAsset`) is what
 * makes an exit obligatory — the CSS only makes it obvious.
 *
 * The clean case keeps its words and its number of steps, exactly as before.
 */

import type { FormErrorContext } from "@web/intake";
import { deleteAssetAction, deleteLiabilityAction } from "@web/patrimonio/actions";
import type { HoldingTrashImpact, TrashExit } from "@worthline/domain";
import { formatMoneyMinorPrivacy, formatUnits, parseTrashExit } from "@worthline/domain";
import Link from "next/link";

import { TRASH_FORM_ID } from "./trash-exit-form";

interface DangerZoneCommonProps {
  /** The holding's own public `wl_hld_…` URL, where the action returns (#1318). */
  currentUrl: string;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  holdingId: string;
  privacyMode?: boolean;
  /**
   * A refused submit, so the door reopens where it was: its own error band, the
   * exit still chosen, and the figures still typed (#1329). Only read when the
   * error belongs to this form.
   */
  formError?: FormErrorContext | null;
}

/**
 * Only an ASSET can carry a trash impact: units live in an operations ledger, and
 * a liability has none. Discriminated rather than a shared nullable field so the
 * notice's copy ("Este activo conserva…") can never render over a debt — the
 * combination is unrepresentable instead of merely unreachable.
 */
type DangerZoneSectionProps = DangerZoneCommonProps &
  (
    | {
        kind: "asset";
        /** What the trash would take with it, or null when it takes nothing. */
        trashImpact: HoldingTrashImpact | null;
        /**
         * The managed portfolio whose cash box this holding is (ADR 0085), when it
         * is one: the door is closed while the cartera lives, so there is nothing
         * to confirm and no exit to offer.
         */
        containerPortfolio?: string | null;
        /**
         * The Traspasar surface's href on this same ficha, when the ficha has one.
         * Absent — a coin collection, a synced holding — and the traspaso exit is
         * not offered, because there is no door to send the owner to.
         */
        transferHref?: string | null;
        /** Today, the date the closing sale defaults to. */
        today: string;
      }
    | {
        kind: "liability";
        trashImpact?: never;
        containerPortfolio?: never;
        transferHref?: never;
        today?: never;
      }
  );

export function DangerZoneSection({
  containerPortfolio,
  currentUrl,
  formError = null,
  holdingId,
  kind,
  privacyMode = false,
  today,
  transferHref,
  trashImpact,
}: DangerZoneSectionProps) {
  const isAsset = kind === "asset";
  const refusal = formError?.formId === TRASH_FORM_ID ? formError : null;

  if (containerPortfolio) {
    return (
      <div className="dangerZone">
        <h3>Zona de peligro</h3>
        <p className="warningBand">
          Este efectivo es la caja de la cartera «{containerPortfolio}»: la creó el alta
          de la cartera, no tú, y guarda las aportaciones que aún no se han invertido. No
          se puede eliminar por su cuenta. Si quieres quitarlo, borra la cartera: al
          disolverla la casilla queda como una cuenta normal, con su saldo intacto.
        </p>
      </div>
    );
  }

  return (
    <div className="dangerZone">
      <h3>Zona de peligro</h3>
      <form action={isAsset ? deleteAssetAction : deleteLiabilityAction}>
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={holdingId} />
        <details
          suppressHydrationWarning
          className="confirmDelete"
          // A refusal reopens the door it came from: an error band above a folded
          // `<details>` is an answer to a question the user can no longer see.
          open={refusal !== null}
        >
          <summary>{isAsset ? "Eliminar activo" : "Eliminar deuda"}</summary>
          {trashImpact ? (
            <TrashGate
              impact={trashImpact}
              privacyMode={privacyMode}
              refusal={refusal}
              today={today ?? ""}
              transferHref={transferHref ?? null}
            />
          ) : (
            <>
              <p>
                {isAsset
                  ? "El activo se moverá a la Papelera y podrás recuperarlo."
                  : "La deuda se moverá a la Papelera y podrás recuperarla."}
              </p>
              <button type="submit">Confirmar eliminación</button>
            </>
          )}
        </details>
      </form>
    </div>
  );
}

/**
 * The door itself, for a holding with money inside: what leaves, that nothing
 * records where it went, and the three exits that do.
 *
 * No exit is preselected. "Nothing chosen" must not resolve to a default, because
 * every default here is an answer the app would be giving on the owner's behalf
 * about where his money went — and with none chosen there is no submit button on
 * screen at all.
 */
function TrashGate({
  impact,
  privacyMode,
  refusal,
  today,
  transferHref,
}: {
  impact: HoldingTrashImpact;
  privacyMode: boolean;
  refusal: FormErrorContext | null;
  today: string;
  transferHref: string | null;
}) {
  const value = formatMoneyMinorPrivacy(impact.value, privacyMode);
  const typed = refusal?.values ?? {};
  const chosenExit: TrashExit | null = parseTrashExit(typed["exit"]);

  return (
    <div className="trashGate">
      {refusal ? (
        <p className="errorBand" role="alert">
          {refusal.message}
        </p>
      ) : null}
      <div className="warningBand">
        <p>
          ⚠ Este activo conserva{" "}
          <strong>{formatUnits(impact.netUnits)} participaciones</strong>, valoradas{" "}
          {impact.basis === "cost" ? "a coste " : ""}en <strong>{value}</strong>. Al
          moverlo a la Papelera ese valor sale de tu patrimonio en la próxima captura, y
          el histórico no registra a dónde fue: no hay venta, ni traspaso, ni ingreso en
          ninguna cuenta.
        </p>
        <p>Dinos a dónde fue el dinero y lo registramos antes de archivarlo.</p>
      </div>

      <fieldset className="trashExits">
        <legend>¿Qué pasó con este activo?</legend>
        <label>
          <input
            defaultChecked={chosenExit === "sold"}
            name="exit"
            type="radio"
            value="sold"
          />
          Lo vendí
        </label>
        {transferHref ? (
          <label>
            <input
              defaultChecked={chosenExit === "transferred"}
              name="exit"
              type="radio"
              value="transferred"
            />
            Lo traspasé a otro producto
          </label>
        ) : null}
        <label>
          <input
            defaultChecked={chosenExit === "mis_entry"}
            name="exit"
            type="radio"
            value="mis_entry"
          />
          Fue un error de registro: ese valor nunca existió
        </label>
      </fieldset>

      <div className="trashExitPane trashSoldPane">
        <label>
          Fecha de la venta
          <input defaultValue={typed["soldAt"] ?? today} name="soldAt" type="date" />
        </label>
        <label>
          Importe recibido
          <input
            defaultValue={typed["soldAmount"] ?? ""}
            inputMode="decimal"
            name="soldAmount"
            placeholder="0,00"
            type="text"
          />
        </label>
        <p className="opCaptureHint">
          Se registrará la venta de las {formatUnits(impact.netUnits)} participaciones que
          quedan, y después el activo se irá a la Papelera.
        </p>
        <button type="submit">Registrar la venta y eliminar</button>
      </div>

      {transferHref ? (
        <div className="trashExitPane trashTransferPane">
          <p>
            Un traspaso se registra en su propia pantalla, porque mueve las
            participaciones a otra inversión y le lleva el coste de adquisición. Al
            guardarlo desde allí, este activo se irá solo a la Papelera.
          </p>
          <Link className="actionLink" href={transferHref}>
            Registrar el traspaso →
          </Link>
        </div>
      ) : null}

      <div className="trashExitPane trashMisEntryPane">
        <p>
          Se archivará tal cual, sin registrar ninguna operación, y quedará dicho en la
          Papelera que ese valor era un error de registro. El patrimonio bajará por ese
          importe: era un valor que nunca tuviste.
        </p>
        <button type="submit">Eliminar sin operación</button>
      </div>
    </div>
  );
}
