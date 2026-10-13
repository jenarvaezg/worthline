/**
 * What the two mirror fichas share (#1849): a Numista collection and a Binance rung
 * are holdings nobody types into (ADR 0016/0021). Their value is what a connected
 * source last mirrored, so what the header owes beside it is WHEN that was, and the
 * one click that asks again.
 *
 * - «Sincronizado» is that figure. Its sync sits beside the date, like «Actualizar
 *   precio» beside an investment's price (#1737): it is a click, not a form, so it
 *   never goes to the bar, whose every action opens a panel.
 * - «Desconectar» is the mirror's one rare action. It waits in «Más», and opens the
 *   same choice Conexiones offers, in the panel.
 */

import { formatLastSync } from "@web/ajustes/numista-helpers";
import { PendingSubmit } from "@web/pending-submit";
import type { ReactNode } from "react";
import type { FichaFigure } from "./family-contract";

/** «Desconectar …»: its `?accion=`. */
export const DISCONNECT_ACTION = "desconectar";

/** The sync beside the date: one source, one click. */
export interface MirrorSync {
  action: (formData: FormData) => void | Promise<void>;
  /** «Sincronizar Numista». */
  label: string;
  sourceId: string;
  /** Where its result returns: the ficha, on its default tab. */
  currentUrl: string;
  /** Demo: the write-guard rejects it, so it is not offered (§10). */
  readOnly: boolean;
}

/**
 * «Sincronizado»: when the source last mirrored this holding, what that reading is
 * worth (`status`) and the sync beside it. With no source there is nothing that
 * syncs: it says so, with no button.
 */
export function syncedFigure({
  lastSyncAt,
  status,
  sync,
}: {
  lastSyncAt: string | null;
  status: ReactNode;
  sync: MirrorSync | null;
}): FichaFigure {
  if (sync === null) {
    return {
      key: "synced",
      kind: "text",
      label: "Sincronizado",
      value: "Sin fuente conectada",
    };
  }
  return {
    detail: (
      <>
        {status}
        <form action={sync.action} className="priceRefreshForm">
          <input name="currentUrl" type="hidden" value={sync.currentUrl} />
          <input name="sourceId" type="hidden" value={sync.sourceId} />
          <PendingSubmit disabled={sync.readOnly} pendingLabel="Sincronizando…">
            {sync.label}
          </PendingSubmit>
        </form>
      </>
    ),
    key: "synced",
    // A stamp, set like «Puesto al día»'s; before the first sync it is the word
    // «Nunca», set in the body face (canon §3).
    ...(lastSyncAt ? {} : { kind: "text" as const }),
    label: "Sincronizado",
    value: formatLastSync(lastSyncAt),
  };
}
