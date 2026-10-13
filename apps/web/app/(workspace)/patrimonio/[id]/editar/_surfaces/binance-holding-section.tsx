/**
 * A Binance rung's tokens (PRD #245, ADR 0021): the «Tokens» tab of its ficha
 * (#1849). Read-only on value — the holding is derived from its token positions
 * valued live (ADR 0021).
 *
 * One row per token, GROUPED across wallets (#247) — a token held on spot ·
 * funding · flexible Earn shows once with the summed value and a wallet caption
 * (symbol · unit price · wallets | balance | live value), sorted by value desc; an
 * unpriceable token shows a "valor 0" warning tag.
 *
 * The unit price is read in the ledger's price voice (`fichaUnitPrice`), never
 * rounded to the céntimo: a token worth a fraction of one read «0 € / ud.» (#1849).
 * What the source's tile used to say went up to the ficha's header.
 *
 * Server-rendered, no client JS (ADR 0009). Reuses the coin-collection CSS classes
 * (the same list/tag treatment) so the two connected sources read identically.
 */

import { fichaUnitPrice } from "@web/patrimonio/[id]/editar/_families/unit-price";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import {
  type BinanceHoldingView,
  formatWallets,
  tokenBasisTag,
} from "./binance-holding-view";

export function BinanceHoldingSection({
  view,
  privacyMode = false,
}: {
  view: BinanceHoldingView;
  privacyMode?: boolean;
}) {
  const eur = (amountMinor: number): string =>
    formatMoneyMinorPrivacy({ amountMinor, currency: "EUR" }, privacyMode);

  return (
    <section className="coinCollection" aria-label="Cuenta Binance">
      {view.rows.length === 0 ? (
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
                <span className="coinThumb">
                  {row.imageUrl ? (
                    // A remote CoinGecko logo, server-rendered (ADR 0009); no
                    // next/image optimizer for an external, list-scale thumb — the
                    // same treatment as the Numista coin gallery (#482).
                    // biome-ignore lint/performance/noImgElement: external exchange icon URL
                    <img
                      alt=""
                      className="coinThumbImg"
                      height={44}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      src={row.imageUrl}
                      width={44}
                    />
                  ) : (
                    <span className="coinThumbFallback" aria-hidden="true" />
                  )}
                </span>
                <span className="coinName">
                  {row.symbol}
                  <small>
                    {row.unitPrice !== null
                      ? ` · ${fichaUnitPrice(row.unitPrice, "EUR", privacyMode)} / ud.`
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
    </section>
  );
}
