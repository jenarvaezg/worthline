"use client";

/**
 * The Papelera, part of the board's footer rather than a stray panel (#271,
 * #1365, #1549; own module since #1608).
 *
 * A deleted holding is not gone: it waits here with the two exits the door
 * offers — restore it, or delete it for good — and, when the door recorded one,
 * the reason it left the book (#1549). Saying that reason HERE is the point:
 * «error de registro» is a declaration about the book, and a Papelera that does
 * not repeat it turns the declaration into something only the database
 * remembers.
 */

import type { OptimisticSubmit } from "@web/patrimonio/_board/use-optimistic-board";
import {
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
  restoreAssetAction,
  restoreLiabilityAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { TrashView } from "@worthline/db";
import type { TrashExit } from "@worthline/domain";
import { trashExitLabel } from "@worthline/domain";

function TrashRow({
  id,
  name,
  restoreAction,
  hardDeleteAction,
  currentUrl,
  optimisticSubmit,
  readOnly,
  trashExit = null,
}: {
  id: string;
  name: string;
  restoreAction: typeof restoreAssetAction;
  hardDeleteAction: typeof hardDeleteAssetAction;
  currentUrl: string;
  optimisticSubmit: OptimisticSubmit;
  readOnly: boolean;
  /** How the holding left the book, when the door recorded it (#1549). */
  trashExit?: TrashExit | null;
}) {
  return (
    <div className="balanceTrashRow">
      <span>
        {name}
        {trashExit ? (
          <small className="balanceTrashExit"> · {trashExitLabel(trashExit)}</small>
        ) : null}
      </span>
      <span className="balanceTrashRowActions">
        {/* Restore is NOT optimistic (§4): the board row it re-adds cannot be
            reconstructed from the trash's {id,name}, so faking it would show a wrong
            value. It stays a plain server-action post that re-renders on its redirect. */}
        <form action={restoreAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <PendingSubmit
            className="btnSmall"
            disabled={readOnly}
            pendingLabel="Restaurando…"
          >
            Restaurar
          </PendingSubmit>
        </form>
        <form
          action={hardDeleteAction}
          onSubmit={optimisticSubmit({ kind: "hardDelete", id }, hardDeleteAction)}
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar definitivamente</summary>
            <button disabled={readOnly} type="submit">
              Confirmar borrado definitivo
            </button>
          </details>
        </form>
      </span>
    </div>
  );
}

export function BoardTrash({
  trash,
  currentUrl,
  optimisticSubmit,
  readOnly,
  open,
}: {
  trash: TrashView;
  currentUrl: string;
  optimisticSubmit: OptimisticSubmit;
  readOnly: boolean;
  /**
   * Render the Papelera already unfolded (#1365). The trashed-with-balance health
   * signal links here to repair the delete, and both repairs live INSIDE this
   * `<details>` — landing on a collapsed one shows the user nothing.
   */
  open: boolean;
}) {
  const trashCount = trash.assets.length + trash.liabilities.length;

  return (
    <details suppressHydrationWarning className="balanceTrash" id="papelera" open={open}>
      <summary>Papelera ({trashCount})</summary>
      {trashCount === 0 ? (
        <p className="balanceTrashEmpty">La papelera está vacía.</p>
      ) : (
        <div className="balanceTrashList">
          {trash.assets.map((item) => (
            <TrashRow
              currentUrl={currentUrl}
              hardDeleteAction={hardDeleteAssetAction}
              id={item.id}
              key={item.id}
              name={item.name}
              optimisticSubmit={optimisticSubmit}
              readOnly={readOnly}
              restoreAction={restoreAssetAction}
              trashExit={item.trashExit ?? null}
            />
          ))}
          {trash.liabilities.map((item) => (
            <TrashRow
              currentUrl={currentUrl}
              hardDeleteAction={hardDeleteLiabilityAction}
              id={item.id}
              key={item.id}
              name={item.name}
              optimisticSubmit={optimisticSubmit}
              readOnly={readOnly}
              restoreAction={restoreLiabilityAction}
            />
          ))}
        </div>
      )}
      {trashCount > 0 ? (
        <form
          action={emptyTrashAction}
          className="balanceTrashEmptyAll"
          onSubmit={optimisticSubmit({ kind: "emptyTrash" }, emptyTrashAction)}
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Vaciar papelera</summary>
            <button disabled={readOnly} type="submit">
              Confirmar vaciado de papelera
            </button>
          </details>
        </form>
      ) : null}
    </details>
  );
}
