"use client";

import {
  type Currency,
  money,
  type PublicIdByHolding,
  type ReturnsById,
} from "@web/patrimonio/_board/board-format";
import { Pane } from "@web/patrimonio/_board/board-pane";
import {
  isClosedPosition,
  sectionsFor,
  sectionTotal,
} from "@web/patrimonio/_board/board-sections";
import { BoardTrash } from "@web/patrimonio/_board/board-trash";
import { useOptimisticBoard } from "@web/patrimonio/_board/use-optimistic-board";
import {
  readOpenPortfoliosFromUrl,
  toggleOpenPortfolio,
  urlWithOpenPortfolios,
} from "@web/patrimonio/board-fold";
import { pushMirroredUrl, useViewStateSync } from "@web/url-view-state";
import type { TrashView } from "@worthline/db";
import type { DomainWarning, PortfolioGroup } from "@worthline/domain";
import Link from "next/link";
import { useCallback, useState } from "react";

/**
 * The /patrimonio holdings list (#271). A two-pane balance sheet: assets left,
 * liabilities right, physically separated so direction never needs a colour to be
 * read. The selected grouping axis (#154) becomes subsections inside each pane — on
 * the liquidity axis a mortgage sits opposite the home it secures. Each pane carries
 * a composition bar (by subsection, in rung colour) and every row a weight bar scaled
 * to its SECTION, so a dominant holding never flattens the smaller rungs into nothing.
 * A footer reconciles Activos − Pasivos = Patrimonio neto, and the Papelera is part
 * of that footer rather than a stray panel.
 *
 * This module is the ASSEMBLY (#1608): it splits the model into the two panes,
 * reconciles the footer and hands each part to the module that owns it — the row
 * (`holding-row`), the managed portfolio (`portfolio-block`), the pane
 * (`board-pane`), the Papelera (`board-trash`) — over the optimistic shell
 * (`use-optimistic-board`) and the URL-mirrored fold (`board-fold`). What used to
 * be one file that grew a variant every time the board learned a new kind of
 * summand is now a board that composes them; the next kind arrives as a module,
 * not as a branch here.
 *
 * The fold is URL state (interaction-patterns §3): the server paints the first
 * frame from the param, the island takes it from there and mirrors every toggle
 * with `pushState`, so Back closes what Forward opened and the link is shareable.
 * No navigation, no round-trip — folding a group re-reads nothing.
 */

export interface BalanceBoardProps {
  groups: PortfolioGroup[];
  isHousehold: boolean;
  warnings: DomainWarning[];
  trash: TrashView;
  currentUrl: string;
  /**
   * Public `wl_hld_…` id per internal holding id (#1318) — the board is where a
   * holding becomes a link, so this is where the two id spaces meet.
   */
  publicIdByHolding: PublicIdByHolding;
  /**
   * Public `wl_prt_…` id per internal portfolio id (#1548) — the group header
   * is a link to the ficha and the fold param names portfolios in the URL.
   */
  publicIdByPortfolio?: PublicIdByHolding;
  /**
   * Portfolios rendered unfolded on the FIRST paint, read from the URL by the
   * server (#1548). Server-rendering the fold is what keeps a shared link from
   * flashing collapsed before hydration.
   */
  initialOpenPortfolios?: ReadonlySet<string>;
  /** Server render instant — anchors the derived-value badge's relative date (#303). */
  nowIso: string;
  privacyMode: boolean;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
  /** Per-holding simple gain, keyed by asset id (#551); absent → no returns shown. */
  returnsById?: ReturnsById;
  /**
   * Asset ids with at least one recorded operation — the guard that separates a
   * fully-sold position (folds away) from a just-created one (stays visible).
   * Absent → nothing folds.
   */
  operatedAssetIds?: ReadonlySet<string>;
  /**
   * Render the Papelera already unfolded (#1365). The trashed-with-balance health
   * signal links here to repair the delete, and both repairs live INSIDE this
   * `<details>` — landing on a collapsed one shows the user nothing.
   */
  trashOpen?: boolean;
}

export default function BalanceBoard({
  groups,
  isHousehold,
  warnings,
  trash,
  currentUrl,
  publicIdByHolding,
  publicIdByPortfolio = {},
  initialOpenPortfolios,
  nowIso,
  privacyMode,
  readOnly = false,
  returnsById,
  operatedAssetIds,
  trashOpen = false,
}: BalanceBoardProps) {
  const returns: ReturnsById = returnsById ?? new Map();
  const { model, isPending, optimisticSubmit } = useOptimisticBoard({
    groups,
    readOnly,
    trash,
  });

  const [openPortfolios, setOpenPortfolios] = useState<ReadonlySet<string>>(
    () => initialOpenPortfolios ?? new Set(),
  );
  const syncFoldFromUrl = useCallback(() => {
    setOpenPortfolios(readOpenPortfoliosFromUrl(window.location.href));
  }, []);
  useViewStateSync(syncFoldFromUrl);

  const togglePortfolio = (publicId: string) => {
    const next = toggleOpenPortfolio(openPortfolios, publicId);
    setOpenPortfolios(next);
    pushMirroredUrl(urlWithOpenPortfolios(window.location.href, next));
  };

  const currency: Currency = model.groups[0]?.totalMinor.currency ?? "EUR";
  // Split fully-sold positions out of the live sections before building them —
  // they fold at the assets pane's foot instead. All 0 €, so no total changes.
  const operatedIds = operatedAssetIds ?? new Set<string>();
  // Only LOOSE rows fold away. A sold-out member stays inside its portfolio: the
  // block promises N positions and its 0 € member costs the total nothing, while
  // moving it out would make the header's count disagree with what unfolds.
  const closedRows = model.groups
    .flatMap((g) =>
      g.units.flatMap((unit) =>
        unit.kind === "holding" && isClosedPosition(unit.holding, operatedIds)
          ? [unit.holding]
          : [],
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const liveGroups = model.groups.map((g) => ({
    ...g,
    units: g.units.filter(
      (unit) => unit.kind === "portfolio" || !isClosedPosition(unit.holding, operatedIds),
    ),
  }));
  const assetSections = sectionsFor(liveGroups, "asset");
  const debtSections = sectionsFor(liveGroups, "liability");
  const grossAssets = assetSections.reduce((acc, s) => acc + sectionTotal(s.units), 0);
  const totalDebts = debtSections.reduce((acc, s) => acc + sectionTotal(s.units), 0);
  const net = grossAssets - totalDebts;

  if (groups.length === 0) {
    return (
      <section aria-label="Activos" className="balanceBoard">
        <p className="balanceEmpty">
          Sin activos todavía. <Link href="/patrimonio/anadir">Añadir activo →</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Activos y pasivos" className="balanceBoard">
      {/* Announce the in-flight save for screen readers (§8). It sits at the board
          root — outside any optimistically-removed row — so the announcement is not
          torn down with the row it describes. The settled outcome is announced by the
          page's existing success/error band (role="status"/"alert") after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>

      <Pane
        closedRows={closedRows}
        currency={currency}
        currentUrl={currentUrl}
        isAsset
        isHousehold={isHousehold}
        nowIso={nowIso}
        onTogglePortfolio={togglePortfolio}
        openPortfolios={openPortfolios}
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
        publicIdByHolding={publicIdByHolding}
        publicIdByPortfolio={publicIdByPortfolio}
        readOnly={readOnly}
        returnsById={returns}
        sections={assetSections}
        title="Activos"
        total={grossAssets}
        warnings={warnings}
      />
      <Pane
        currency={currency}
        currentUrl={currentUrl}
        isAsset={false}
        isHousehold={isHousehold}
        nowIso={nowIso}
        onTogglePortfolio={togglePortfolio}
        openPortfolios={openPortfolios}
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
        publicIdByHolding={publicIdByHolding}
        publicIdByPortfolio={publicIdByPortfolio}
        readOnly={readOnly}
        returnsById={returns}
        sections={debtSections}
        title="Pasivos"
        total={totalDebts}
        warnings={warnings}
      />

      <div className="balanceRecon">
        <span className="balanceReconTitle">Balance</span>
        <div className="balanceReconFigures">
          <span className="balanceReconItem">
            <span className="balanceReconLabel">Activos</span>
            <span className="balanceReconValue">
              {money(grossAssets, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem">
            <span className="balanceReconOp">−</span>
            <span className="balanceReconLabel">Pasivos</span>
            <span className="balanceReconValue">
              {money(totalDebts, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem balanceReconNet">
            <span className="balanceReconOp">=</span>
            <span className="balanceReconLabel">Patrimonio neto</span>
            <span
              className={`balanceReconValue totalRule${net < 0 ? " balanceReconNeg" : ""}`}
            >
              {money(net, currency, privacyMode)}
            </span>
          </span>
        </div>
      </div>

      <BoardTrash
        currentUrl={currentUrl}
        open={trashOpen}
        optimisticSubmit={optimisticSubmit}
        readOnly={readOnly}
        trash={model.trash}
      />
    </section>
  );
}
