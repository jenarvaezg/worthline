/**
 * The Binance crypto holding detail surface (PRD #245, ADR 0021). Rendered on the
 * holding detail page when the asset's instrument is `crypto` AND it is backed by
 * a connected `binance` source (a MANUAL crypto investment keeps its operations
 * editor instead). Read-only on value — the holding is derived from its token
 * positions valued live (ADR 0021), so there is no manual value field; ownership
 * stays editable through the shared AssetEditForm above this surface.
 *
 * Two parts, in order:
 *  1. Connected-source tile: status pill + «Sincronizar Binance» + last-sync /
 *     tokens / value stats, mirroring the Numista tile.
 *  2. Token list: one row per token, GROUPED across wallets (#247) — a token held
 *     on spot · funding · flexible Earn shows once with the summed value and a
 *     wallet caption (symbol · unit price · wallets | balance | live value),
 *     sorted by value desc; an unpriceable token shows a "valor 0" warning tag.
 *
 * Server-rendered, no client JS (ADR 0009): the list is plain markup, sync /
 * disconnect are form POSTs. Reuses the coin-collection CSS classes (the same
 * tile/list/tag treatment) so the two connected sources read identically.
 */

import { formatMoneyMinor } from "@worthline/domain";
import type { TokenPosition } from "@worthline/domain";

import {
  disconnectBinanceAction,
  syncBinanceAction,
} from "../../../../ajustes/binance-actions";
import { formatLastSync } from "../../../../ajustes/binance-helpers";
import { PendingSubmit } from "../../../../pending-submit";
import {
  buildBinanceHoldingView,
  formatBinanceSince,
  formatWallets,
  tokenBasisTag,
} from "./binance-holding-view";

const eur = (amountMinor: number): string =>
  formatMoneyMinor({ amountMinor, currency: "EUR" });

export function BinanceHoldingSection({
  positions,
  sourceId,
  lastSyncAt,
  sinceDateKey,
  currentUrl,
}: {
  positions: TokenPosition[];
  sourceId: string | null;
  lastSyncAt: string | null;
  /** The earliest snapshot dateKey carrying this asset's frozen row — how far back
   *  the reconstructed monthly history reaches (PRD #245 S5, #250). Null until a
   *  backfill has run. Rendered as "Datos desde DD/MM/YYYY" when present. */
  sinceDateKey: string | null;
  currentUrl: string;
}) {
  const view = buildBinanceHoldingView(positions);
  const since = formatBinanceSince(sinceDateKey);

  return (
    <section className="coinCollection" aria-label="Cuenta Binance">
      {/* ── Connected-source tile ─────────────────────────────────────────── */}
      <div className="coinSourceTile">
        <div className="coinSourceStatus">
          <span className="coinStatusPill">Conectado</span>
          <dl className="coinSourceStats">
            <div>
              <dt>Última sincronización</dt>
              <dd>{formatLastSync(lastSyncAt)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd className="coinNum">{view.tokenCount}</dd>
            </div>
            <div>
              <dt>Valor</dt>
              <dd className="coinNum">{eur(view.totalMinor)}</dd>
            </div>
            {since ? (
              <div>
                <dt>Histórico</dt>
                <dd>{since}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {sourceId ? (
          <form action={syncBinanceAction} className="coinSyncForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="sourceId" type="hidden" value={sourceId} />
            <PendingSubmit pendingLabel="Sincronizando…">
              Sincronizar Binance
            </PendingSubmit>
          </form>
        ) : null}
      </div>

      {positions.length === 0 ? (
        <p className="infoNote">
          Aún no hay tokens. Pulsa «Sincronizar Binance» para traer tus saldos.
        </p>
      ) : (
        <div className="coinList">
          {view.rows.map((row) => {
            const tag = tokenBasisTag(row.basis);
            const wallets = formatWallets(row.wallets);
            return (
              <div className="coinLine" key={row.id}>
                <span className="coinName">
                  {row.symbol}
                  <small>
                    {row.unitPrice !== null
                      ? ` · ${eur(Math.round(Number(row.unitPrice) * 100))} / ud.`
                      : " · sin precio"}
                    {wallets ? ` · ${wallets}` : ""}
                  </small>
                </span>
                <span className="coinNum">{row.balance}</span>
                <span className="coinAmount coinNum">
                  <strong>{eur(row.valueMinor)}</strong>
                  <span className={`coinTag ${tag.cls}`}>{tag.label}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Disconnect (folded) — S1 remove path only ──────────────────────── */}
      {sourceId ? (
        <div className="coinDisconnect">
          <form action={disconnectBinanceAction}>
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="sourceId" type="hidden" value={sourceId} />
            <details className="confirmDelete">
              <summary>Desconectar Binance</summary>
              <p className="dangerExplain">
                Las credenciales se borran de este dispositivo y el activo se elimina; tu
                cuenta en Binance no se toca. Los snapshots ya guardados conservan el
                histórico.
              </p>
              <button type="submit">Eliminar y conservar histórico</button>
            </details>
          </form>
        </div>
      ) : null}
    </section>
  );
}
