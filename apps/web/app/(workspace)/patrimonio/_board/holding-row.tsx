"use client";

/**
 * One loose holding as a row of the balance board (#271, #1608).
 *
 * The row is the board's unit of paper: name (a door to the ficha), amount with
 * its inline gain, an actions menu, and a weight bar scaled to its SECTION so a
 * dominant holding never flattens the smaller rungs into nothing. Its own module
 * since #1608 — the board composes rows, it does not grow a variant of one.
 */

import { formatRatioPct, returnsTooltipLines } from "@web/_components/returns-format";
import { holdingDetailHref } from "@web/holding-route";
import {
  barColor,
  type Currency,
  magnitude,
  money,
  ownershipLabel,
  type PublicIdByHolding,
} from "@web/patrimonio/_board/board-format";
import type { OptimisticSubmit } from "@web/patrimonio/_board/use-optimistic-board";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
} from "@web/patrimonio/actions";
import { boardRefreshHover } from "@web/price-refresh";
import type {
  DomainWarning,
  HoldingReturnsView,
  UnifiedHolding,
} from "@worthline/domain";
import Link from "next/link";

/**
 * The per-holding simple total gain, inline under the amount (#551, ADR 0040). The
 * gain is computed on the FULL position, so scale it to the row's scope share to
 * stay consistent with the (scope-weighted) value above it; the percentage is
 * share-invariant. Semantic gain/loss colour via the shared `.pos`/`.neg` tokens
 * (design-system §2), never raw green/red. The hover — a real focusable tooltip,
 * not a native `title` — explains the three measures and the honest caveats.
 */
function RowReturns({
  returns,
  shareBps,
  currency,
  privacyMode,
}: {
  returns: HoldingReturnsView;
  shareBps: number;
  currency: Currency;
  privacyMode: boolean;
}) {
  if (returns.totalReturnRatio === null) {
    return null;
  }
  const scaledGainMinor = Math.round((returns.totalGain.amountMinor * shareBps) / 10_000);
  const positive = returns.totalReturnRatio >= 0;
  const lines = returnsTooltipLines(returns);

  // The row is tabbable, so focusing it has to say what it is. On a bare div
  // (role `generic`) ARIA maps no author name: it took focus and announced
  // nothing. `group` is the role that carries the label (#1275).
  return (
    <div
      className={`balanceRowReturns returnsHint ${positive ? "pos" : "neg"}`}
      tabIndex={0}
      role="group"
      aria-label={`Rentabilidad: ${lines.join(". ")}`}
    >
      <span aria-hidden="true">{positive ? "▲" : "▼"}</span>{" "}
      {money(scaledGainMinor, currency, privacyMode)} ·{" "}
      {formatRatioPct(returns.totalReturnRatio)}
      <span className="returnsHintBody" role="tooltip">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </div>
  );
}

export function HoldingRow({
  holding,
  currency,
  isAsset,
  isHousehold,
  warnings,
  currentUrl,
  publicIdByHolding,
  sectionDenom,
  showTierLabel,
  nowIso,
  privacyMode,
  optimisticSubmit,
  returns,
  readOnly,
  banded,
}: {
  holding: UnifiedHolding;
  currency: Currency;
  isAsset: boolean;
  isHousehold: boolean;
  warnings: DomainWarning[];
  currentUrl: string;
  publicIdByHolding: PublicIdByHolding;
  sectionDenom: number;
  showTierLabel: boolean;
  nowIso: string;
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
  returns: HoldingReturnsView | undefined;
  readOnly: boolean;
  /** Alternate rows band (canon §5, «papel rayado»). */
  banded: boolean;
}) {
  const h = holding;
  const rowWarnings = isAsset
    ? warnings.filter((w) => w.entityType === "asset" && w.entityId === h.id)
    : [];
  const ack = rowWarnings.find((w) => w.severity === "overrideable");
  const derived = h.direction === "asset" && h.valueIsDerived;
  // Enrich the derived-value badge's native hover with WHEN/WHO last priced it
  // (#303). Only an investment valued from the price cache carries this; null for
  // a manual-priced one, so the title stays just "Valor calculado (…)".
  const refreshHover =
    h.direction === "asset"
      ? boardRefreshHover(h.priceFetchedAt, h.priceSource, nowIso)
      : null;
  const own = ownershipLabel(h, isHousehold);
  const pct = (magnitude(h) / sectionDenom) * 100;
  const deleteAction = isAsset ? deleteAssetAction : deleteLiabilityAction;
  // The row is addressed by the holding's public `wl_hld_…` id (#1318): both the
  // ficha link and the anchor a mutation lands on. The internal id stays in the
  // hidden fields below, where it is storage plumbing and not a URL.
  //
  // A holding with no registry row cannot happen (every creation path mints one)
  // and there is deliberately no fallback to the internal id: linking to it would
  // re-open the leak this issue closed, for a URL that no longer resolves anyway.
  // The row still renders — with its name unlinked — so a registry gap costs one
  // door, not the whole board.
  const publicId = publicIdByHolding[h.id];
  const detailHref = publicId ? holdingDetailHref(publicId) : null;

  return (
    <div className={`balanceRow${banded ? " band" : ""}`} id={publicId ?? undefined}>
      <div className="balanceRowName">
        {detailHref ? <Link href={detailHref}>{h.name}</Link> : <span>{h.name}</span>}
        {rowWarnings.length > 0 ? (
          <span
            className="warningBadge"
            role="img"
            aria-label={rowWarnings[0]!.message}
            title={rowWarnings[0]!.message}
          >
            {" "}
            ⚠
          </span>
        ) : null}
        <div className="balanceRowSub">
          {showTierLabel && h.tierLabel ? <span>{h.tierLabel}</span> : null}
          {own ? <span>· {own}</span> : null}
        </div>
      </div>

      <div className="balanceRowAmount">
        {derived ? (
          <abbr
            className="balanceCalc"
            aria-label="Valor calculado"
            title={`Valor calculado (unidades × precio)${refreshHover ?? ""}`}
          >
            ≈
          </abbr>
        ) : null}
        {isAsset
          ? money(magnitude(h), currency, privacyMode)
          : `− ${money(magnitude(h), currency, privacyMode)}`}
        {isAsset && returns ? (
          <RowReturns
            currency={currency}
            privacyMode={privacyMode}
            returns={returns}
            shareBps={h.direction === "asset" ? h.ownership.totalShareBps : 10_000}
          />
        ) : null}
      </div>

      <details suppressHydrationWarning className="balanceActions">
        <summary aria-label={`Acciones para ${h.name}`}>⋯</summary>
        <div className="balanceMenu">
          {detailHref ? <Link href={detailHref}>Editar</Link> : null}
          {ack ? (
            <form action={acknowledgeWarningAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="code" type="hidden" value={ack.code} />
              <input name="entityId" type="hidden" value={h.id} />
              <button className="balanceMenuAck" disabled={readOnly} type="submit">
                Es intencional
              </button>
            </form>
          ) : null}
          <form
            action={deleteAction}
            onSubmit={optimisticSubmit({ kind: "delete", id: h.id }, deleteAction)}
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={h.id} />
            <details suppressHydrationWarning className="confirmDelete balanceMenuDelete">
              <summary>Eliminar</summary>
              <button disabled={readOnly} type="submit">
                Confirmar
              </button>
            </details>
          </form>
        </div>
      </details>

      <div className="balanceRowBar">
        <span
          style={{
            width: `${pct}%`,
            background: barColor(h.tier, isAsset),
          }}
        />
      </div>
    </div>
  );
}
