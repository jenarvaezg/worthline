/**
 * The Numista collection's coins (PRD #160 / #163, variant B «Reparto por metal»):
 * the «Monedas» tab of its ficha (#1849). Read-only on value — the collection is
 * derived from its positions (ADR 0016).
 *
 * Two parts, in order:
 *  1. Composition strip: a 100 %-stacked bar of the metal split — the signature.
 *  2. Equalizer: one tall bar per metal, descending by value, each a CLOSED
 *     `<details>` opening to a minimal headerless list of its coins (name · grade
 *     · year · ×qty · value + basis tag). Never a multi-column table.
 *
 * What the source's tile used to say — its status, its last sync, its count, its
 * own «Valor» — went up to the ficha's header (#1849), where the value is the
 * board's figure and is said once.
 *
 * Server-rendered, no client JS (ADR 0009): the strip/bars are CSS, the coin
 * lists are native `<details>`.
 */

import { coinValue, coinValueGap, formatMoneyMinorPrivacy } from "@worthline/domain";
import {
  basisTag,
  type CoinCollectionView,
  coinNumistaUrl,
  coinYear,
  formatSharePct,
  metalCoinCount,
} from "./coin-collection-view";

export function CoinCollectionSection({
  view,
  hasSource,
  privacyMode = false,
}: {
  view: CoinCollectionView;
  /** Whether a source can bring coins at all — what the empty state can offer. */
  hasSource: boolean;
  privacyMode?: boolean;
}) {
  const eur = (amountMinor: number): string =>
    formatMoneyMinorPrivacy({ amountMinor, currency: "EUR" }, privacyMode);

  return (
    <section className="coinCollection" aria-label="Colección Numista">
      {view.rows.length === 0 ? (
        <p className="infoNote">
          {hasSource
            ? "Aún no hay monedas. Pulsa «Sincronizar Numista» para traer tu colección."
            : "Aún no hay monedas."}
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
                  suppressHydrationWarning
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
                      const tag = basisTag(valuation.basis, coinValueGap(position));
                      const year = coinYear(position);
                      const numistaUrl = coinNumistaUrl(position.catalogueId);
                      return (
                        <div className="coinLine" key={position.id}>
                          <span className="coinThumb">
                            {position.obverseThumbUrl ? (
                              // A remote Numista CDN photo, server-rendered (ADR 0009); no
                              // next/image optimizer for an external, list-scale thumb.
                              // biome-ignore lint/performance/noImgElement: external coin thumb URL
                              <img
                                alt=""
                                className="coinThumbImg"
                                height={44}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                src={position.obverseThumbUrl}
                                width={44}
                              />
                            ) : (
                              <span className="coinThumbFallback" aria-hidden="true" />
                            )}
                          </span>
                          <span className="coinName">
                            {numistaUrl ? (
                              <a
                                className="coinNameLink"
                                href={numistaUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Ver «${position.name}» en Numista`}
                              >
                                {position.name}
                                <span className="coinExtIcon" aria-hidden="true">
                                  ↗
                                </span>
                              </a>
                            ) : (
                              position.name
                            )}
                            <small>
                              {" "}
                              · {position.grade}
                              {year ? ` · ${year}` : ""}
                            </small>
                          </span>
                          <span className="coinQty coinNum">×{position.quantity}</span>
                          <span className="coinAmount coinNum">
                            <strong>{eur(valuation.minor)}</strong>
                            <span className={`coinTag ${tag.cls}`} title={tag.hint}>
                              {tag.label}
                            </span>
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
    </section>
  );
}
