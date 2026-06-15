/**
 * The Numista coin-collection detail surface (PRD #160 / #163, variant B
 * «Reparto por metal»). Rendered on the holding detail page when the asset's
 * instrument is `coin_collection`. Read-only on value — the collection is derived
 * from its positions (ADR 0016), so there is no manual value field; ownership
 * stays editable through the shared AssetEditForm above this surface.
 *
 * Three parts, in order:
 *  1. Connected-source tile: status pill + «Sincronizar Numista» + last-sync /
 *     coins / value stats, and a folded Desconectar.
 *  2. Composition strip: a 100 %-stacked bar of the metal split — the signature.
 *  3. Equalizer: one tall bar per metal, descending by value, each a CLOSED
 *     `<details>` opening to a minimal headerless list of its coins (name · grade
 *     · year · ×qty · value + basis tag). Never a multi-column table.
 *
 * Server-rendered, no client JS (ADR 0009): the strip/bars are CSS, the coin
 * lists are native `<details>`, sync/disconnect are form POSTs.
 */

import { coinValue, formatMoneyMinor, groupPositionsByMetal } from "@worthline/domain";
import type { PriceFreshnessState, SourcePosition } from "@worthline/domain";

import DisconnectNumistaFold from "../../../../ajustes/disconnect-numista-fold";
import { syncNumistaAction } from "../../../../ajustes/numista-actions";
import { formatLastSync } from "../../../../ajustes/numista-helpers";
import {
  basisTag,
  buildCoinCollectionView,
  formatSharePct,
  metalCoinCount,
} from "./coin-collection-view";

const eur = (amountMinor: number): string =>
  formatMoneyMinor({ amountMinor, currency: "EUR" });

const coinYear = (position: SourcePosition): string | null => {
  const date = position.purchaseDate;
  return date && date.length >= 4 ? date.slice(0, 4) : null;
};

export function CoinCollectionSection({
  positions,
  sourceId,
  lastSyncAt,
  currentUrl,
  valuationFreshness = null,
  valuationStaleReason = null,
}: {
  positions: SourcePosition[];
  sourceId: string | null;
  lastSyncAt: string | null;
  currentUrl: string;
  /** Freshness of the collection's valuation refresh (PRD #166): "stale"/"failed"
   *  when the last decoupled refresh hit a Numista outage and kept last-known. */
  valuationFreshness?: PriceFreshnessState | null;
  valuationStaleReason?: string | null;
}) {
  const groups = groupPositionsByMetal(positions);
  const totalMinor = groups.reduce((sum, group) => sum + group.subtotalMinor, 0);
  const view = buildCoinCollectionView(groups, totalMinor);

  // The valuation rides the daily stale-price pass; on an outage it keeps the
  // last-known value and flags itself stale (ADR 0017) — surface that here.
  const valuationStale =
    valuationFreshness === "stale" || valuationFreshness === "failed";

  return (
    <section className="coinCollection" aria-label="Colección Numista">
      {/* ── Connected-source tile ─────────────────────────────────────────── */}
      <div className="coinSourceTile">
        <div className="coinSourceStatus">
          <span className={`coinStatusPill${valuationStale ? " isStale" : ""}`}>
            {valuationStale ? "Valoración desactualizada" : "Conectado"}
          </span>
          <dl className="coinSourceStats">
            <div>
              <dt>Última sincronización</dt>
              <dd>{formatLastSync(lastSyncAt)}</dd>
            </div>
            <div>
              <dt>Monedas</dt>
              <dd className="coinNum">{view.coinCount}</dd>
            </div>
            <div>
              <dt>Valor</dt>
              <dd className="coinNum">{eur(view.totalMinor)}</dd>
            </div>
          </dl>
        </div>

        {sourceId ? (
          <form action={syncNumistaAction} className="coinSyncForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="sourceId" type="hidden" value={sourceId} />
            <button type="submit">Sincronizar Numista</button>
          </form>
        ) : null}
      </div>

      {valuationStale && valuationStaleReason ? (
        <p className="infoNote" role="status">
          {valuationStaleReason} Se muestra el último valor conocido.
        </p>
      ) : null}

      {positions.length === 0 ? (
        <p className="infoNote">
          Aún no hay monedas. Pulsa «Sincronizar Numista» para traer tu colección.
        </p>
      ) : (
        <>
          {/* ── Composition strip ───────────────────────────────────────── */}
          <span
            className="coinStrip"
            role="img"
            aria-label="Reparto por metal de la colección"
          >
            {view.segments.map((segment) => (
              <i
                key={segment.metal ?? "sin-metal"}
                style={{
                  flexBasis: `${segment.width}%`,
                  background: segment.identity.tone,
                }}
                title={`${segment.identity.label} · ${formatSharePct(segment.pct)}`}
              />
            ))}
          </span>

          {/* ── Equalizer: one descending bar per metal ─────────────────── */}
          <div className="coinEqualizer">
            {view.rows.map((row) => {
              const coins = metalCoinCount(row.positions);
              return (
                <details
                  className="coinMetalRow"
                  key={row.metal ?? "sin-metal"}
                  style={{ ["--coin-tone" as string]: row.identity.tone }}
                >
                  <summary>
                    <span className="coinMetalLabel">
                      {row.identity.label}
                      <small> · {row.positions.length} pos.</small>
                    </span>
                    <span className="coinMetalBar" aria-hidden="true">
                      <i style={{ width: `${row.barWidth}%` }} />
                      <b className="coinMetalPct">{formatSharePct(row.pct)}</b>
                    </span>
                    <span className="coinMetalVal coinNum">
                      {eur(row.subtotalMinor)}
                      <small>
                        {coins} {coins === 1 ? "moneda" : "monedas"}
                      </small>
                    </span>
                  </summary>

                  <div className="coinList">
                    {row.positions.map((position) => {
                      const valuation = coinValue(position);
                      const tag = basisTag(valuation.basis);
                      const year = coinYear(position);
                      return (
                        <div className="coinLine" key={position.id}>
                          <span className="coinName">
                            {position.name}
                            <small>
                              {" "}
                              · {position.grade}
                              {year ? ` · ${year}` : ""}
                            </small>
                          </span>
                          <span className="coinNum">×{position.quantity}</span>
                          <span className="coinAmount coinNum">
                            <strong>{eur(valuation.minor)}</strong>
                            <span className={`coinTag ${tag.cls}`}>{tag.label}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}

      {/* ── Disconnect (folded) ───────────────────────────────────────────── */}
      {sourceId ? (
        <div className="coinDisconnect">
          <DisconnectNumistaFold
            currentUrl={currentUrl}
            sourceId={sourceId}
            summary="Desconectar Numista"
          />
        </div>
      ) : null}
    </section>
  );
}
